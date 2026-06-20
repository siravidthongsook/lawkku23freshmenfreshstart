import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db, type Tx } from "../../db/client";
import { users, temporaryPasswords } from "../../db/schema/users";
import { userImports } from "../../db/schema/imports";
import { events } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManageUsers } from "../../lib/permissions";
import { badRequest, notFound } from "../../lib/errors";
import { hashPassword, generateTempPassword } from "../../lib/password";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { writeAudit } from "../../lib/audit";
import {
  confirmImportSchema,
  importResultQuery,
  type ImportResultRow,
  type ImportResultSummary,
  type ImportRow,
} from "./schema";
import { buildPreviewRows, parseCsv, tallyCounts } from "./service";
import { toCsv } from "./csv-out";

const router = new Hono<{ Variables: AppVariables }>();
const adminOnly = [requireAuth, requirePermission(canManageUsers)] as const;

// POST /admin/imports/users/preview — parse CSV, compute row statuses, persist a previewed batch.
router.post("/admin/imports/users/preview", ...adminOnly, async (c) => {
  const user = c.get("user");

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw badRequest("missing_file", "CSV file is required");
  const filename = file.name || "import.csv";
  if (!filename.toLowerCase().endsWith(".csv")) {
    // CSV-only in V1 (no XLSX). Reject other types up front.
    throw badRequest("unsupported_file_type", "Only CSV files are supported");
  }

  // Optional scope/event hints so capacity flagging is accurate at preview time.
  const scope =
    typeof body.scope === "string" && body.scope === "user_pool_and_register_to_event"
      ? "user_pool_and_register_to_event"
      : "user_pool_only";
  const targetEventId =
    typeof body.targetEventId === "string" && body.targetEventId ? body.targetEventId : null;
  const registerToEvent = scope === "user_pool_and_register_to_event";
  if (registerToEvent && !targetEventId)
    throw badRequest("missing_event", "targetEventId required for this scope");

  const text = await file.text();
  const raw = parseCsv(text);
  if (!raw.length) throw badRequest("empty_file", "No data rows found");

  const rows = await buildPreviewRows(raw, { registerToEvent, targetEventId });
  const summary: ImportResultSummary = {
    scope,
    targetEventId,
    counts: tallyCounts(rows),
    rows,
  };

  const [batch] = await db
    .insert(userImports)
    .values({
      adminId: user.id,
      filename,
      scope,
      targetEventId,
      status: "previewed",
      resultSummary: summary,
    })
    .returning({ id: userImports.id });
  if (!batch) throw badRequest("import_failed", "Could not create import batch");

  return c.json({ importId: batch.id, scope, targetEventId, counts: summary.counts, rows });
});

// POST /admin/imports/users/confirm — apply the previewed batch.
router.post(
  "/admin/imports/users/confirm",
  ...adminOnly,
  zValidator("json", confirmImportSchema),
  async (c) => {
    const user = c.get("user");
    const meta = requestMeta(c);
    const { importId } = c.req.valid("json");

    const [batch] = await db.select().from(userImports).where(eq(userImports.id, importId)).limit(1);
    if (!batch) throw notFound("Import batch not found");
    if (batch.status !== "previewed")
      throw badRequest("invalid_state", "Import is not in previewed state");

    const summary = batch.resultSummary as ImportResultSummary | null;
    if (!summary) throw badRequest("invalid_state", "Import has no preview data");

    // BUG B fix: confirm applies EXACTLY what was previewed. scope/targetEventId come from the
    // persisted batch, NOT the request body — preview-time capacity analysis can't be bypassed.
    const scope = batch.scope;
    const targetEventId = batch.targetEventId;
    const registerToEvent = scope === "user_pool_and_register_to_event";
    if (registerToEvent && !targetEventId)
      throw badRequest("missing_event", "targetEventId required");

    if (registerToEvent && targetEventId) {
      const [ev] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, targetEventId))
        .limit(1);
      if (!ev) throw notFound("Target event not found");
    }

    // Temp passwords are generated outside the tx (argon2 is async/CPU) then applied inside.
    // BUG A fix: result rows NEVER store the plaintext temp pw — created rows carry only the userId
    // so the result endpoint can decrypt on demand (opt-in + reason + audit). Encrypted store is truth.
    const resultRows: ImportResultRow[] = [];
    type Pending = { row: ImportRow; tempPlain: string; hash: string };
    const toCreate: Pending[] = [];
    const toUpdate: ImportRow[] = [];

    for (const row of summary.rows) {
      const exists = await emailExists(row.email);
      if ((row.status === "will_create" || row.status === "will_register_over_capacity") && !exists) {
        const tempPlain = generateTempPassword();
        const hash = await hashPassword(tempPlain);
        toCreate.push({ row, tempPlain, hash });
      } else if (row.status === "will_update" || row.status === "will_register_over_capacity") {
        toUpdate.push(row);
      }
      // invalid / duplicate_* are skipped.
    }

    let createdCount = 0;
    let updatedCount = 0;
    let registeredCount = 0;
    let overCapacityCount = 0;

    await db.transaction(async (tx) => {
      // Create new users + temp-password row (must_change=true). Do NOT touch existing passwords.
      for (const p of toCreate) {
        const [created] = await tx
          .insert(users)
          .values({
            email: p.row.email,
            studentId: p.row.studentId,
            role: "student",
            fullName: p.row.fullName,
            faculty: p.row.faculty,
            department: p.row.department,
            phone: p.row.phone,
            passwordHash: p.hash,
            passwordMustChange: true,
            createdByAdminId: user.id,
          })
          .returning({ id: users.id });
        if (!created) continue; // insert always returns; guard for type-narrowing
        await tx.insert(temporaryPasswords).values({
          userId: created.id,
          encryptedTempPassword: encryptSecret(p.tempPlain),
          createdByAdminId: user.id,
        });
        createdCount++;
        // Store userId (not plaintext) — result endpoint decrypts temp pw on demand from encrypted store.
        resultRows.push({ ...p.row, result: "created", userId: created.id });

        if (registerToEvent && targetEventId) {
          const over = await registerUser(tx, targetEventId, created.id);
          if (over !== null) {
            registeredCount++;
            if (over) {
              overCapacityCount++;
              await writeAudit(
                {
                  actorUserId: user.id,
                  actorRole: user.role,
                  action: "admin_register_over_capacity",
                  entityType: "registration",
                  eventId: targetEventId,
                  targetUserId: created.id,
                  reason: "import register over capacity",
                  metadata: { source: "user_import", import_id: importId },
                  ...meta,
                },
                tx,
              );
            }
          }
        }
      }

      // Update existing users — profile only, never password.
      for (const row of toUpdate) {
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, row.email))
          .limit(1);
        if (!existing) {
          resultRows.push({ ...row, result: "skipped_not_found" });
          continue;
        }
        await tx
          .update(users)
          .set({
            studentId: row.studentId,
            fullName: row.fullName,
            faculty: row.faculty,
            department: row.department,
            phone: row.phone,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id));
        updatedCount++;
        resultRows.push({ ...row, result: "updated" });

        if (registerToEvent && targetEventId) {
          const over = await registerUser(tx, targetEventId, existing.id);
          if (over !== null) {
            registeredCount++;
            if (over) {
              overCapacityCount++;
              await writeAudit(
                {
                  actorUserId: user.id,
                  actorRole: user.role,
                  action: "admin_register_over_capacity",
                  entityType: "registration",
                  eventId: targetEventId,
                  targetUserId: existing.id,
                  reason: "import register over capacity",
                  metadata: { source: "user_import", import_id: importId },
                  ...meta,
                },
                tx,
              );
            }
          }
        }
      }

      const finalSummary = {
        scope,
        targetEventId: targetEventId ?? null,
        counts: {
          created: createdCount,
          updated: updatedCount,
          registered: registeredCount,
          over_capacity: overCapacityCount,
        },
        rows: summary.rows,
        result: resultRows,
      };

      await tx
        .update(userImports)
        .set({
          status: "confirmed",
          scope,
          targetEventId: targetEventId ?? null,
          resultSummary: finalSummary,
          updatedAt: new Date(),
        })
        .where(eq(userImports.id, importId));

      // Audit counts ONLY (no PII / temp passwords).
      await writeAudit(
        {
          actorUserId: user.id,
          actorRole: user.role,
          action: "users_imported",
          entityType: "user_import",
          entityId: importId,
          eventId: targetEventId ?? null,
          metadata: {
            created: createdCount,
            updated: updatedCount,
            registered: registeredCount,
            over_capacity: overCapacityCount,
          },
          ...meta,
        },
        tx,
      );
    });

    return c.json({
      importId,
      created: createdCount,
      updated: updatedCount,
      registered: registeredCount,
      over_capacity: overCapacityCount,
    });
  },
);

// GET /admin/imports/:importId/result — downloadable CSV of the stored result.
// temp_password is opt-in ONLY + reason-gated + audited (mirrors GET/POST users-export reveal in
// src/modules/users/routes.ts). Default download carries NO temp_password column → never leaks plaintext.
router.get(
  "/admin/imports/:importId/result",
  ...adminOnly,
  zValidator("query", importResultQuery),
  async (c) => {
    const user = c.get("user");
    const meta = requestMeta(c);
    const importId = c.req.param("importId");
    const { include_temp_password: includeTempPassword, reason } = c.req.valid("query");

    // Reason guard fires before any DB/CSV/audit work — mirrors users export's reason_required gate.
    if (includeTempPassword && !reason) {
      return c.json(
        { error: "reason_required", message: "Reason is required to reveal temporary passwords" },
        400,
      );
    }

    const [batch] = await db
      .select()
      .from(userImports)
      .where(eq(userImports.id, importId))
      .limit(1);
    if (!batch) throw notFound("Import batch not found");

    const summary = batch.resultSummary as ImportResultSummary | null;
    if (!summary) throw notFound("No result available");

    // Confirmed batches expose per-row outcome (summary.result); previewed expose computed rows only.
    const source: (ImportRow | ImportResultRow)[] = summary.result ?? summary.rows;

    // Decrypt temp pw on demand from the encrypted store (single source of truth) — only when opted in.
    // Per-row try/catch so one undecryptable ciphertext (e.g. rotated key) can't 500 the whole download.
    const tempPwById = new Map<string, string>();
    let revealedCount = 0;
    if (includeTempPassword && summary.result?.length) {
      const ids = summary.result
        .filter((r): r is ImportResultRow => "userId" in r && !!r.userId)
        .map((r) => r.userId!);
      if (ids.length) {
        const pendingRows = await db
          .select({
            userId: temporaryPasswords.userId,
            encrypted: temporaryPasswords.encryptedTempPassword,
          })
          .from(temporaryPasswords)
          .where(inArray(temporaryPasswords.userId, ids));
        for (const p of pendingRows) {
          try {
            tempPwById.set(p.userId, decryptSecret(p.encrypted));
            revealedCount++;
          } catch {
            // never log/audit the plaintext; only the failure signal.
            tempPwById.set(p.userId, "<decrypt-error>");
            c.get("log")?.event("temp_pw_decrypt_failed", { userId: p.userId });
          }
        }
      }
    }

    const records = source.map((r) => {
      const userId = "userId" in r ? r.userId : undefined;
      return {
        row_number: r.rowNumber,
        email: r.email,
        student_id: r.studentId ?? "",
        full_name: r.fullName,
        status: r.status,
        result: "result" in r ? (r.result ?? "") : "",
        // temp_password column emitted ONLY when opted in; plaintext from on-demand decrypt.
        temp_password: includeTempPassword ? (userId ? (tempPwById.get(userId) ?? "") : "") : "",
        note: r.note ?? "",
      };
    });

    // Columns: omit temp_password entirely unless opted in (default download never carries it).
    const columns = [
      "row_number",
      "email",
      "student_id",
      "full_name",
      "status",
      "result",
      ...(includeTempPassword ? (["temp_password"] as const) : []),
      "note",
    ];

    const csv = toCsv(records, columns);

    // Audit the reveal — mirrors users_exported: reason stored only when plaintext left the system,
    // included_temp_password flag is greppable for security review; count only, never the plaintext.
    if (includeTempPassword) {
      await writeAudit({
        actorUserId: user.id,
        actorRole: user.role,
        action: "import_result_revealed",
        entityType: "user_import",
        entityId: importId,
        reason,
        metadata: { included_temp_password: true, revealed_count: revealedCount },
        ...meta,
      });
    }

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="import-${importId}-result.csv"`);
    return c.body(csv);
  },
);

// --- helpers ---

async function emailExists(email: string): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return !!u;
}

// Register user to event (override window). Returns true if over capacity, false if within, null if already active.
async function registerUser(tx: Tx, eventId: string, userId: string): Promise<boolean | null> {
  // Lock event row, count live registrations for an accurate capacity decision.
  const [ev] = await tx
    .select({ capacityEnabled: events.capacityEnabled, capacityLimit: events.capacityLimit })
    .from(events)
    .where(eq(events.id, eventId))
    .for("update")
    .limit(1);

  const [existing] = await tx
    .select({ id: registrations.id, status: registrations.status })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
    .limit(1);

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        inArray(registrations.status, ["registered", "checked_in"]),
      ),
    );
  const count = Number(countRows[0]?.count ?? 0);
  const over = !!ev?.capacityEnabled && ev.capacityLimit != null && count >= ev.capacityLimit;

  if (existing) {
    // Already registered/checked_in → leave as-is. Revive cancelled/waitlisted to registered (override).
    if (existing.status === "registered" || existing.status === "checked_in") return null;
    await tx
      .update(registrations)
      .set({ status: "registered", registeredAt: new Date(), updatedAt: new Date() })
      .where(eq(registrations.id, existing.id));
    return over;
  }

  await tx
    .insert(registrations)
    .values({ eventId, userId, status: "registered", registeredAt: new Date() });
  return over;
}

export default router;
