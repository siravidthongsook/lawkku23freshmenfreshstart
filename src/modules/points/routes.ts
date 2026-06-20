import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { pointGrantTokens, staffBudgetLedger } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { writeAudit } from "../../lib/audit";
import { toBangkokString } from "../../lib/time";
import {
  canAdjustPoints,
  canDeductPoints,
  canManagePointConfig,
  canReverseOwnRecentGrant,
  canTopupStaffBudget,
} from "../../lib/permissions";
import { AppError } from "../../lib/errors";
import { pointRateLimit } from "../../lib/point-rate-limit";
import { getBalance, getLedgerEntryDetail, listUserLedger, serializeLedgerEntry } from "./service";
import { adjustBudget, getStaffBudget } from "./budget-service";
import {
  getEventPointConfig,
  getPointSettings,
  serializeEventPointConfig,
  serializePointSettings,
  updatePointSettings,
  upsertEventPointConfig,
} from "./config-service";
import { listLeaderboard, listLeaderboardForExport, rankOf } from "./leaderboard-service";
import { listStaffGrants } from "./grants-report-service";
import { toCsv } from "../exports/csv-out";
import { claimGrantToken, getGrantTokenQr, issueGrantToken, revokeGrantToken } from "./grant-service";
import {
  adminCorrect,
  adminReverseLedgerEntry,
  manualAdjust,
  staffSelfReverse,
} from "./adjust-service";
import {
  connectPeer,
  getOrCreateConnectToken,
  listConnections,
  setFavorite,
} from "./peer-service";

const router = new Hono<{ Variables: AppVariables }>();

// Pagination — consistent with other list endpoints (audit-logs uses the same shape).
const ledgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /me/points — own balance + paginated ledger history (newest first). Reads own data only.
router.get("/me/points", requireAuth, zValidator("query", ledgerQuery), async (c) => {
  const user = c.get("user");
  const { limit, offset } = c.req.valid("query");
  const [balance, page] = await Promise.all([
    getBalance(user.id),
    listUserLedger(user.id, limit, offset),
  ]);
  return c.json({
    balance,
    history: page.rows.map(serializeLedgerEntry),
    total: page.total,
    limit,
    offset,
  });
});

// GET /me/points/:ledgerId — hydrated detail of ONE of the caller's own ledger entries (wallet detail view).
// Ownership-scoped: an id that isn't the caller's own returns 404 (no enumeration). Param is uuid-validated.
router.get("/me/points/:ledgerId", requireAuth, async (c) => {
  const user = c.get("user");
  const ledgerId = z.string().uuid().parse(c.req.param("ledgerId"));
  const detail = await getLedgerEntryDetail(user.id, ledgerId);
  if (!detail) return c.json({ error: "not_found", message: "Ledger entry not found" }, 404);
  return c.json({ entry: detail });
});

// =====================================================================
// LEADERBOARD — app-wide ranked students (plan §5). Authenticated users only (§12.3 "login only");
// no special permission — any role may view (staff/admin just won't appear in it).
// =====================================================================

const leaderboardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  group_number: z.coerce.number().int().min(1).optional(), // optional view-by-group filter
});

// GET /leaderboard — ranked active students (balance DESC, earliest-to-reach tiebreak), paginated.
// Also returns the CALLER'S own app-wide rank ("myRank") so they see where they stand off-page;
// null when the caller isn't a ranked student (staff/admin/disabled).
router.get("/leaderboard", requireAuth, zValidator("query", leaderboardQuery), async (c) => {
  const user = c.get("user");
  const { limit, offset, group_number } = c.req.valid("query");
  const [page, mine] = await Promise.all([
    listLeaderboard({ groupNumber: group_number ?? null, limit, offset }),
    rankOf(user.id),
  ]);
  return c.json({
    leaderboard: page.rows,
    total: page.total,
    limit,
    offset,
    myRank: mine, // { rank, pointsBalance } | null
  });
});

// =====================================================================
// STAFF + ADMIN — grant tokens, manual adjust, self-reverse, own budget
// =====================================================================

const issueBody = z.object({
  points_value: z.coerce.number().int().min(1).max(100000),
  max_claims: z.coerce.number().int().min(1).max(100000),
  event_id: z.string().uuid().optional(),
  expires_at: z.coerce.date().optional(),
});

// POST /points/grant-tokens — staff/admin spend budget to mint a grant QR. Returns plaintext ONCE.
router.post(
  "/points/grant-tokens",
  requireAuth,
  requirePermission(canAdjustPoints),
  pointRateLimit("grant_issue"), // lenient burst-log only (§15.7, no hard cap)
  zValidator("json", issueBody),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    try {
      const { token, plaintext, reused } = await issueGrantToken({
        issuerUserId: user.id,
        pointsValue: body.points_value,
        maxClaims: body.max_claims,
        eventId: body.event_id ?? null,
        expiresAt: body.expires_at ?? null,
      });
      // New token → 201. Reused (an identical unscanned QR existed) → 200, no budget spent.
      return c.json(
        {
          token: plaintext,
          tokenId: token.id,
          pointsValue: token.pointsValue,
          maxClaims: token.maxClaims,
          expiresAt: token.expiresAt?.toISOString() ?? null,
          reused,
        },
        reused ? 200 : 201,
      );
    } catch (e) {
      // insufficient_budget from adjustBudget → 400; everything else bubbles to errorHandler.
      if (e instanceof AppError) return c.json({ error: e.code, message: e.message }, e.status as 400);
      throw e;
    }
  },
);

const reasonBody = z.object({ reason: z.string().min(1) });

// POST /points/grant-tokens/:id/revoke — staff (own) or admin; refunds unclaimed seats to the issuer.
router.post(
  "/points/grant-tokens/:id/revoke",
  requireAuth,
  requirePermission(canAdjustPoints),
  zValidator("json", reasonBody),
  async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const user = c.get("user");
    const { reason } = c.req.valid("json");
    const res = await revokeGrantToken({
      tokenId: id,
      actorUserId: user.id,
      actorIsAdmin: user.role === "admin",
      reason,
    });
    const status = res.result === "revoked" ? 200 : res.result === "grant_not_found" ? 404 : 400;
    return c.json(res, status);
  },
);

// GET /points/grant-tokens/:id/qr — issuer (or admin) re-displays an active QR's plaintext (no new token).
router.get(
  "/points/grant-tokens/:id/qr",
  requireAuth,
  requirePermission(canAdjustPoints),
  async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const user = c.get("user");
    const res = await getGrantTokenQr({
      tokenId: id,
      actorUserId: user.id,
      actorIsAdmin: user.role === "admin",
    });
    if (res.result !== "ok") {
      return c.json({ error: res.result }, res.result === "grant_not_found" ? 404 : 400);
    }
    return c.json({
      token: res.plaintext,
      tokenId: res.token.id,
      pointsValue: res.token.pointsValue,
      maxClaims: res.token.maxClaims,
      claimsUsed: res.token.claimsUsed,
      expiresAt: res.token.expiresAt?.toISOString() ?? null,
    });
  },
);

// GET /points/my-budget — staff/admin own budget + recent budget ledger.
router.get("/points/my-budget", requireAuth, requirePermission(canAdjustPoints), async (c) => {
  const user = c.get("user");
  const [budget, rows] = await Promise.all([
    getStaffBudget(user.id),
    db
      .select()
      .from(staffBudgetLedger)
      .where(eq(staffBudgetLedger.staffUserId, user.id))
      .orderBy(desc(staffBudgetLedger.createdAt))
      .limit(100),
  ]);
  return c.json({
    budget,
    history: rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      reason_code: r.reasonCode,
      grant_token_id: r.grantTokenId,
      target_user_id: r.targetUserId,
      // staff self-reverse UI needs the backing ledger id to know which grant it can undo (Gap A)
      related_ledger_id: r.relatedLedgerId,
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
    })),
  });
});

// Min 2 chars to avoid trawling the whole table; cap results so the typeahead stays small.
const studentSearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
});

// GET /points/student-search — typeahead for the staff/admin manual-give flow. Gated by the SAME
// audience that can grant points (canAdjustPoints = staff + admin). Returns ONLY active students
// and ONLY the minimal fields needed to pick + confirm — no email/phone/balance (no extra PII leak;
// matches what leaderboard/connect already expose, plus studentId which staff already see in grants).
router.get(
  "/points/student-search",
  requireAuth,
  requirePermission(canAdjustPoints),
  zValidator("query", studentSearchQuery),
  async (c) => {
    const { q } = c.req.valid("query");
    const pat = `%${q}%`;
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        nickname: users.nickname,
        studentId: users.studentId,
        groupNumber: users.groupNumber,
      })
      .from(users)
      .where(
        and(
          eq(users.role, "student"),
          eq(users.status, "active"),
          or(ilike(users.fullName, pat), ilike(users.nickname, pat), ilike(users.studentId, pat)),
        ),
      )
      .orderBy(asc(users.fullName))
      .limit(20);
    return c.json({ students: rows });
  },
);

const adjustBody = z.object({
  user_id: z.string().uuid(),
  delta: z.coerce.number().int(),
  reason: z.string().min(1), // sensitive action — reason REQUIRED
});

// POST /points/adjust — manual give/deduct. Staff = +only from budget; admin = unlimited +/−.
router.post(
  "/points/adjust",
  requireAuth,
  requirePermission(canAdjustPoints),
  pointRateLimit("adjust"), // lenient burst-log only (§15.7, no hard cap)
  zValidator("json", adjustBody),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const res = await manualAdjust({
      actorUserId: user.id,
      actorRole: user.role,
      actorName: user.fullName,
      targetUserId: body.user_id,
      delta: body.delta,
      reason: body.reason,
    });
    const ok = res.result === "adjusted";
    return c.json(res, ok ? 200 : 400);
  },
);

// POST /points/grant/:ledgerId/reverse — staff undo own recent manual-grant within the window (refunds budget).
router.post(
  "/points/grant/:ledgerId/reverse",
  requireAuth,
  requirePermission(canReverseOwnRecentGrant),
  zValidator("json", reasonBody),
  async (c) => {
    const ledgerId = z.string().uuid().parse(c.req.param("ledgerId"));
    const user = c.get("user");
    const { reason } = c.req.valid("json");
    const res = await staffSelfReverse({
      actorUserId: user.id,
      actorIsAdmin: user.role === "admin",
      ledgerId,
      reason,
    });
    const status = res.result === "reversed" ? 200 : res.result === "ledger_not_found" ? 404 : 400;
    return c.json(res, status);
  },
);

// =====================================================================
// STUDENT — claim a staff grant QR
// =====================================================================

const claimBody = z.object({ token: z.string().min(1) });

// POST /points/claim — student claims a staff grant QR (awards once; idempotent re-claim).
router.post("/points/claim", requireAuth, pointRateLimit("claim"), zValidator("json", claimBody), async (c) => {
  const user = c.get("user");
  const { token } = c.req.valid("json");
  const res = await claimGrantToken({
    plaintext: token,
    studentUserId: user.id,
    studentRole: user.role,
  });
  // Always HTTP 200 with a result code (mirror the scan flow — UI branches on result).
  return c.json(res);
});

// =====================================================================
// ADMIN — staff budget management + corrections
// =====================================================================

const userIdParam = z.object({ userId: z.string().uuid() });
const topupBody = z.object({ amount: z.coerce.number().int().min(1), reason: z.string().min(1) });

// POST /admin/staff/:userId/point-budget/topup — admin tops up a staff member's budget (+).
router.post(
  "/admin/staff/:userId/point-budget/topup",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  zValidator("json", topupBody),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const admin = c.get("user");
    const { amount, reason } = c.req.valid("json");
    const res = await adjustBudget({
      staffUserId: userId,
      delta: amount,
      reasonCode: "topup",
      createdByUserId: admin.id,
      auditAction: "budget_topup",
      reason,
    });
    return c.json({ result: "topped_up", budget: res.budget });
  },
);

const budgetAdjustBody = z.object({ delta: z.coerce.number().int(), reason: z.string().min(1) });

// POST /admin/staff/:userId/point-budget/adjust — admin signed adjust (admin_adjust); rejects would_go_negative.
router.post(
  "/admin/staff/:userId/point-budget/adjust",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  zValidator("json", budgetAdjustBody),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const admin = c.get("user");
    const { delta, reason } = c.req.valid("json");
    try {
      const res = await adjustBudget({
        staffUserId: userId,
        delta,
        reasonCode: "admin_adjust",
        createdByUserId: admin.id,
        auditAction: "budget_adjust",
        rejectIfNegative: true,
        reason,
      });
      return c.json({ result: "adjusted", budget: res.budget });
    } catch (e) {
      if (e instanceof AppError) return c.json({ error: e.code, message: e.message }, e.status as 400);
      throw e;
    }
  },
);

const bulkTopupBody = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(500),
  amount: z.coerce.number().int().min(1),
  reason: z.string().min(1),
});

// POST /admin/staff/point-budget/topup-bulk — event-day: top up many staff in one tx.
router.post(
  "/admin/staff/point-budget/topup-bulk",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  zValidator("json", bulkTopupBody),
  async (c) => {
    const admin = c.get("user");
    const { user_ids, amount, reason } = c.req.valid("json");
    const updated = await db.transaction(async (tx) => {
      const out: { userId: string; budget: number }[] = [];
      for (const uid of user_ids) {
        const res = await adjustBudget(
          {
            staffUserId: uid,
            delta: amount,
            reasonCode: "topup",
            createdByUserId: admin.id,
            auditAction: "budget_topup",
            reason,
          },
          tx,
        );
        out.push({ userId: uid, budget: res.budget });
      }
      return out;
    });
    return c.json({ result: "topped_up", updated });
  },
);

// GET /admin/staff/budgets — overview of every staff member's budget + usage flags.
router.get(
  "/admin/staff/budgets",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  async (c) => {
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        username: users.username,
        budget: users.staffPointBudget,
        status: users.status,
      })
      .from(users)
      .where(eq(users.role, "checkin_staff"));
    return c.json({
      staff: rows.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        username: r.username,
        budget: r.budget,
        status: r.status,
        lowBudget: r.budget < 10, // event-day "needs topup" flag
      })),
    });
  },
);

// GET /admin/staff/:userId/point-budget — one staff member's budget + full budget ledger + active tokens.
router.get(
  "/admin/staff/:userId/point-budget",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const [budget, ledger, tokens] = await Promise.all([
      getStaffBudget(userId),
      db
        .select()
        .from(staffBudgetLedger)
        .where(eq(staffBudgetLedger.staffUserId, userId))
        .orderBy(desc(staffBudgetLedger.createdAt)),
      db
        .select({
          id: pointGrantTokens.id,
          pointsValue: pointGrantTokens.pointsValue,
          maxClaims: pointGrantTokens.maxClaims,
          claimsUsed: pointGrantTokens.claimsUsed,
          status: pointGrantTokens.status,
          createdAt: pointGrantTokens.createdAt,
        })
        .from(pointGrantTokens)
        .where(
          and(
            eq(pointGrantTokens.createdByUserId, userId),
            eq(pointGrantTokens.status, "active"),
          ),
        ),
    ]);
    return c.json({
      budget,
      ledger: ledger.map((r) => ({
        id: r.id,
        delta: r.delta,
        reason_code: r.reasonCode,
        grant_token_id: r.grantTokenId,
        target_user_id: r.targetUserId,
        related_ledger_id: r.relatedLedgerId,
        reason: r.reason,
        created_by_user_id: r.createdByUserId,
        created_at: r.createdAt.toISOString(),
      })),
      activeTokens: tokens.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    });
  },
);

// GET /admin/users/:userId/points — full ledger of a student (for review before reverse/correct).
router.get(
  "/admin/users/:userId/points",
  requireAuth,
  requirePermission(canDeductPoints),
  zValidator("query", ledgerQuery),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const { limit, offset } = c.req.valid("query");
    const [balance, page] = await Promise.all([getBalance(userId), listUserLedger(userId, limit, offset)]);
    return c.json({
      balance,
      history: page.rows.map(serializeLedgerEntry),
      total: page.total,
      limit,
      offset,
    });
  },
);

// GET /admin/users/:userId/points/export — full point-ledger CSV for one student (audit / dispute
// trail before results announcement, plan §7). Admin only (canDeductPoints — the correction audience).
// Reuses the formula-injection-safe csv-out; timestamp column is Bangkok-labeled per CLAUDE.md.
router.get(
  "/admin/users/:userId/points/export",
  requireAuth,
  requirePermission(canDeductPoints),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    // No pagination — admin pulls the whole ledger once for the audit file (mirrors leaderboard export).
    const { rows } = await listUserLedger(userId, 1_000_000, 0);
    const records = rows.map((r) => ({
      ledger_id: r.id,
      delta: r.delta,
      reason_code: r.reasonCode,
      reversal_of_ledger_id: r.reversalOfLedgerId ?? "",
      created_by_user_id: r.createdByUserId ?? "",
      reason: ((r.metadata as Record<string, unknown> | null)?.reason as string | undefined) ?? "",
      created_at_bangkok: toBangkokString(r.createdAt),
    }));
    const csv = toCsv(records, [
      "ledger_id",
      "delta",
      "reason_code",
      "reversal_of_ledger_id",
      "created_by_user_id",
      "reason",
      "created_at_bangkok",
    ]);
    // Audit the export itself (append-only) — who pulled a student's full point history, and how many rows.
    await writeAudit({
      actorUserId: c.get("user").id,
      actorRole: c.get("user").role,
      action: "point_ledger_exported",
      entityType: "user",
      entityId: userId,
      targetUserId: userId,
      metadata: { row_count: records.length },
      ...requestMeta(c),
    });
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="user-${userId}-points.csv"`);
    c.header("X-Row-Count", String(records.length));
    c.header("Access-Control-Expose-Headers", "X-Row-Count, Content-Disposition");
    return c.body(csv);
  },
);

const reverseBody = z.object({ ledger_id: z.string().uuid(), reason: z.string().min(1) });

// POST /admin/users/:userId/points/reverse — admin reverses ANY ledger entry (bypasses cutoff).
router.post(
  "/admin/users/:userId/points/reverse",
  requireAuth,
  requirePermission(canDeductPoints),
  zValidator("json", reverseBody),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const admin = c.get("user");
    const { ledger_id, reason } = c.req.valid("json");
    const res = await adminReverseLedgerEntry({
      actorUserId: admin.id,
      targetUserId: userId,
      ledgerId: ledger_id,
      reason,
    });
    const status = res.result === "reversed" ? 200 : res.result === "ledger_not_found" ? 404 : 400;
    return c.json(res, status);
  },
);

const correctBody = z.object({ delta: z.coerce.number().int(), reason: z.string().min(1) });

// POST /admin/users/:userId/points/correct — admin freeform correcting entry (correction_add).
router.post(
  "/admin/users/:userId/points/correct",
  requireAuth,
  requirePermission(canDeductPoints),
  zValidator("json", correctBody),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const admin = c.get("user");
    const { delta, reason } = c.req.valid("json");
    const res = await adminCorrect({
      actorUserId: admin.id,
      targetUserId: userId,
      delta,
      reason,
    });
    const status = res.result === "corrected" ? 200 : res.result === "not_found" ? 404 : 400;
    return c.json(res, status);
  },
);

// =====================================================================
// STUDENT — peer connect (add-friend), connect-QR, retroactive list, favourites (plan §4.5/§4.8)
// =====================================================================

// GET /me/connect-qr — caller's personal connect token (lazy-created); ?rotate=1 mints a fresh one.
router.get("/me/connect-qr", requireAuth, async (c) => {
  const user = c.get("user");
  const rotate = c.req.query("rotate") === "1" || c.req.query("rotate") === "true";
  const { token, plaintext } = await getOrCreateConnectToken(user.id, rotate);
  // plaintext is the QR payload; only the hash is persisted (no-PII QR invariant).
  return c.json({ token: plaintext, tokenId: token.id, status: token.status });
});

const connectBody = z.object({ token: z.string().min(1) });

// POST /points/connect — scanner connects a peer; scanner earns +peerPoints once per ordered pair.
// Always HTTP 200 with a result code (mirror scan/claim — UI branches on result).
router.post("/points/connect", requireAuth, pointRateLimit("connect"), zValidator("json", connectBody), async (c) => {
  const user = c.get("user");
  const { token } = c.req.valid("json");
  const res = await connectPeer({
    plaintext: token,
    scannerUserId: user.id,
    scannerRole: user.role,
  });
  return c.json(res);
});

const connectionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  favorite: z.coerce.boolean().optional(), // true = favourites only
});

// GET /me/connections — caller's scanned-people history (newest first), with the peer's contact. Own list only.
router.get("/me/connections", requireAuth, zValidator("query", connectionsQuery), async (c) => {
  const user = c.get("user");
  const { limit, offset, favorite } = c.req.valid("query");
  const page = await listConnections(user.id, { limit, offset, favoritesOnly: favorite === true });
  return c.json({ connections: page.rows, total: page.total, limit, offset });
});

const favoriteBody = z.object({ favorite: z.boolean() });

// POST /me/connections/:id/favorite — set/unset favourite on one of the caller's own connections.
router.post(
  "/me/connections/:id/favorite",
  requireAuth,
  zValidator("json", favoriteBody),
  async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const user = c.get("user");
    const { favorite } = c.req.valid("json");
    // Scoped to the caller — a connection id they don't own returns not_found (404), not someone else's row.
    const res = await setFavorite({ scannerUserId: user.id, connectionId: id, favorite });
    return c.json(res, res.result === "not_found" ? 404 : 200);
  },
);

// =====================================================================
// ADMIN — point-settings (cutoff freeze + global defaults), per-event config,
// staff grants listing, leaderboard export (plan §5/§7)
// =====================================================================

// GET /admin/point-settings — current singleton settings (lazy-creates row 1 on first read).
router.get(
  "/admin/point-settings",
  requireAuth,
  requirePermission(canManagePointConfig),
  async (c) => {
    const settings = await getPointSettings();
    return c.json({ settings: serializePointSettings(settings) });
  },
);

// PATCH body — all fields optional; cutoff_at accepts null (= unfreeze). Bounds mirror the schema.
const pointSettingsPatchBody = z
  .object({
    cutoff_at: z.coerce.date().nullable().optional(),
    default_checkin_in_points: z.coerce.number().int().min(0).max(100000).optional(),
    default_checkin_out_points: z.coerce.number().int().min(0).max(100000).optional(),
    default_assessment_points: z.coerce.number().int().min(0).max(100000).optional(),
    scan_out_fallback_hours: z.coerce.number().int().min(0).max(168).optional(),
    peer_enabled: z.boolean().optional(),
    peer_points: z.coerce.number().int().min(0).max(100000).optional(),
    peer_cooldown_sec: z.coerce.number().int().min(0).max(86400).optional(),
    staff_reverse_window_min: z.coerce.number().int().min(0).max(1440).optional(),
    reason: z.string().min(1).optional(), // recorded with the audit entry (cutoff is sensitive)
  })
  .refine((b) => Object.keys(b).some((k) => k !== "reason"), {
    message: "at least one setting must be provided",
  });

// PATCH /admin/point-settings — edit cutoff + global defaults/peer/reverse-window (plan §5/§7).
router.patch(
  "/admin/point-settings",
  requireAuth,
  requirePermission(canManagePointConfig),
  zValidator("json", pointSettingsPatchBody),
  async (c) => {
    const admin = c.get("user");
    const b = c.req.valid("json");
    // Map snake_case wire keys → camelCase patch (only include keys actually present).
    const patch: Record<string, unknown> = {};
    if ("cutoff_at" in b) patch.cutoffAt = b.cutoff_at ?? null;
    if (b.default_checkin_in_points !== undefined) patch.defaultCheckinInPoints = b.default_checkin_in_points;
    if (b.default_checkin_out_points !== undefined) patch.defaultCheckinOutPoints = b.default_checkin_out_points;
    if (b.default_assessment_points !== undefined) patch.defaultAssessmentPoints = b.default_assessment_points;
    if (b.scan_out_fallback_hours !== undefined) patch.scanOutFallbackHours = b.scan_out_fallback_hours;
    if (b.peer_enabled !== undefined) patch.peerEnabled = b.peer_enabled;
    if (b.peer_points !== undefined) patch.peerPoints = b.peer_points;
    if (b.peer_cooldown_sec !== undefined) patch.peerCooldownSec = b.peer_cooldown_sec;
    if (b.staff_reverse_window_min !== undefined) patch.staffReverseWindowMin = b.staff_reverse_window_min;
    const settings = await updatePointSettings({
      patch,
      actorUserId: admin.id,
      reason: b.reason ?? null,
    });
    return c.json({ result: "updated", settings: serializePointSettings(settings) });
  },
);

const eventIdParam = z.object({ eventId: z.string().uuid() });

// GET /admin/events/:eventId/point-config — per-event override row (null = all global defaults).
router.get(
  "/admin/events/:eventId/point-config",
  requireAuth,
  requirePermission(canManagePointConfig),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const config = await getEventPointConfig(eventId);
    return c.json({ config: serializeEventPointConfig(config) });
  },
);

// PATCH body — toggles + nullable point/window overrides. Point values & windows accept null (= use default).
const eventConfigPatchBody = z
  .object({
    checkin_in_enabled: z.boolean().optional(),
    checkin_out_enabled: z.boolean().optional(),
    assessment_enabled: z.boolean().optional(),
    assessment_requires_checkin: z.boolean().optional(),
    checkin_in_points: z.coerce.number().int().min(0).max(100000).nullable().optional(),
    checkin_out_points: z.coerce.number().int().min(0).max(100000).nullable().optional(),
    assessment_points: z.coerce.number().int().min(0).max(100000).nullable().optional(),
    scan_in_open_at: z.coerce.date().nullable().optional(),
    scan_in_close_at: z.coerce.date().nullable().optional(),
    scan_out_open_at: z.coerce.date().nullable().optional(),
    scan_out_close_at: z.coerce.date().nullable().optional(),
    assessment_open_at: z.coerce.date().nullable().optional(),
    assessment_close_at: z.coerce.date().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field must be provided" });

// PATCH /admin/events/:eventId/point-config — set per-event overrides (lazy-creates the row, §15.3).
router.patch(
  "/admin/events/:eventId/point-config",
  requireAuth,
  requirePermission(canManagePointConfig),
  zValidator("json", eventConfigPatchBody),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const admin = c.get("user");
    const b = c.req.valid("json");
    // snake_case wire → camelCase column patch (only present keys; null is meaningful = clear override).
    const patch: Record<string, unknown> = {};
    if (b.checkin_in_enabled !== undefined) patch.checkinInEnabled = b.checkin_in_enabled;
    if (b.checkin_out_enabled !== undefined) patch.checkinOutEnabled = b.checkin_out_enabled;
    if (b.assessment_enabled !== undefined) patch.assessmentEnabled = b.assessment_enabled;
    if (b.assessment_requires_checkin !== undefined)
      patch.assessmentRequiresCheckin = b.assessment_requires_checkin;
    if ("checkin_in_points" in b) patch.checkinInPoints = b.checkin_in_points ?? null;
    if ("checkin_out_points" in b) patch.checkinOutPoints = b.checkin_out_points ?? null;
    if ("assessment_points" in b) patch.assessmentPoints = b.assessment_points ?? null;
    if ("scan_in_open_at" in b) patch.scanInOpenAt = b.scan_in_open_at ?? null;
    if ("scan_in_close_at" in b) patch.scanInCloseAt = b.scan_in_close_at ?? null;
    if ("scan_out_open_at" in b) patch.scanOutOpenAt = b.scan_out_open_at ?? null;
    if ("scan_out_close_at" in b) patch.scanOutCloseAt = b.scan_out_close_at ?? null;
    if ("assessment_open_at" in b) patch.assessmentOpenAt = b.assessment_open_at ?? null;
    if ("assessment_close_at" in b) patch.assessmentCloseAt = b.assessment_close_at ?? null;
    const config = await upsertEventPointConfig({ eventId, patch, actorUserId: admin.id });
    return c.json({ result: "updated", config: serializeEventPointConfig(config) });
  },
);

const staffGrantsQuery = z.object({
  method: z.enum(["qr", "manual"]).optional(),
  q: z.string().optional(),
});

// GET /admin/staff/:userId/grants — every student this staff member granted to (QR + manual), §14.
router.get(
  "/admin/staff/:userId/grants",
  requireAuth,
  requirePermission(canTopupStaffBudget),
  zValidator("query", staffGrantsQuery),
  async (c) => {
    const { userId } = userIdParam.parse(c.req.param());
    const { method, q } = c.req.valid("query");
    const res = await listStaffGrants({ staffUserId: userId, method, q: q ?? null });
    return c.json(res);
  },
);

const exportQuery = z.object({ group_number: z.coerce.number().int().min(1).optional() });

// GET /admin/leaderboard/export — full ranked CSV for results announcement (plan §5). Admin only.
router.get(
  "/admin/leaderboard/export",
  requireAuth,
  requirePermission(canManagePointConfig),
  zValidator("query", exportQuery),
  async (c) => {
    const { group_number } = c.req.valid("query");
    const rows = await listLeaderboardForExport(group_number ?? null);
    const records = rows.map((r) => ({
      rank: r.rank,
      full_name: r.fullName,
      nickname: r.nickname ?? "",
      group_number: r.groupNumber ?? "",
      points_balance: r.pointsBalance,
    }));
    const csv = toCsv(records, ["rank", "full_name", "nickname", "group_number", "points_balance"]);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="leaderboard.csv"`);
    c.header("X-Row-Count", String(records.length));
    c.header("Access-Control-Expose-Headers", "X-Row-Count, Content-Disposition");
    return c.body(csv);
  },
);

export default router;
