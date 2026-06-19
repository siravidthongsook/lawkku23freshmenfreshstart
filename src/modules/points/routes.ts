import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { pointGrantTokens, staffBudgetLedger } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { requireAuth, requirePermission } from "../../lib/auth-middleware";
import {
  canAdjustPoints,
  canDeductPoints,
  canReverseOwnRecentGrant,
  canTopupStaffBudget,
} from "../../lib/permissions";
import { AppError } from "../../lib/errors";
import { getBalance, listUserLedger, serializeLedgerEntry } from "./service";
import { adjustBudget, getStaffBudget } from "./budget-service";
import { claimGrantToken, issueGrantToken, revokeGrantToken } from "./grant-service";
import {
  adminCorrect,
  adminReverseLedgerEntry,
  manualAdjust,
  staffSelfReverse,
} from "./adjust-service";

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
  zValidator("json", issueBody),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    try {
      const { token, plaintext } = await issueGrantToken({
        issuerUserId: user.id,
        pointsValue: body.points_value,
        maxClaims: body.max_claims,
        eventId: body.event_id ?? null,
        expiresAt: body.expires_at ?? null,
      });
      // plaintext returned exactly once — only the hash is persisted (QR invariant).
      return c.json(
        {
          token: plaintext,
          tokenId: token.id,
          pointsValue: token.pointsValue,
          maxClaims: token.maxClaims,
          expiresAt: token.expiresAt?.toISOString() ?? null,
        },
        201,
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
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
    })),
  });
});

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
router.post("/points/claim", requireAuth, zValidator("json", claimBody), async (c) => {
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

export default router;
