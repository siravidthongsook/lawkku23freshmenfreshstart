import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { events } from "../../db/schema/events";
import { registrations, registrationFormAnswers } from "../../db/schema/registrations";
import { users } from "../../db/schema/users";
import { uploadedFiles } from "../../db/schema/files";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canExportRegistrations } from "../../lib/permissions";
import { notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { toBangkokString } from "../../lib/time";
import { exportFiltersSchema, type ExportFilters } from "./schema";
import { toCsv } from "./csv-out";

const router = new Hono<{ Variables: AppVariables }>();
const adminOnly = [requireAuth, requirePermission(canExportRegistrations)] as const;

// Build the WHERE predicate from event + optional filters. date_range applies to registered_at.
function buildWhere(eventId: string, f: ExportFilters): SQL | undefined {
  const conds = [eq(registrations.eventId, eventId)];
  if (f.status) conds.push(eq(registrations.status, f.status));
  if (f.form_version) conds.push(eq(registrations.formVersionId, f.form_version));
  if (f.from) conds.push(gte(registrations.registeredAt, new Date(f.from)));
  if (f.to) conds.push(lte(registrations.registeredAt, new Date(f.to)));
  return and(...conds);
}

// Common base rows: registration + the user identity. Reused by all three exports.
async function fetchBase(eventId: string, f: ExportFilters) {
  return db
    .select({
      reg: registrations,
      user: {
        email: users.email,
        studentId: users.studentId,
        fullName: users.fullName,
        faculty: users.faculty,
        department: users.department,
        phone: users.phone,
      },
    })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(buildWhere(eventId, f));
}

async function requireEvent(eventId: string) {
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev) throw notFound("Event not found");
  return ev;
}

type AppCtx = Context<{ Variables: AppVariables }>;

function auditExport(c: AppCtx, eventId: string, kind: string, count: number) {
  const user = c.get("user");
  const meta = requestMeta(c);
  // Central span for all three export kinds — captures kind + row count + which event.
  c.get("log")?.event("export", { kind, eventId, rowCount: count });
  return writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "registration_exported",
    entityType: "event",
    entityId: eventId,
    eventId,
    metadata: { export: kind, row_count: count },
    ...meta,
  });
}

function csvResponse(c: AppCtx, filename: string, csv: string, rowCount: number) {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  // Surface the matched data-row count so the client can warn on zero-match / show how many rows.
  c.header("X-Row-Count", String(rowCount));
  c.header("Access-Control-Expose-Headers", "X-Row-Count, Content-Disposition");
  return c.body(csv);
}

// GET /admin/events/:eventId/export/registrations-summary — one row per registration, identity + status + timestamps.
router.get(
  "/admin/events/:eventId/export/registrations-summary",
  ...adminOnly,
  zValidator("query", exportFiltersSchema),
  async (c) => {
    const eventId = c.req.param("eventId");
    await requireEvent(eventId);
    const f = c.req.valid("query");

    const base = await fetchBase(eventId, f);
    const records = base.map(({ reg, user }) => ({
      registration_id: reg.id,
      email: user.email,
      student_id: user.studentId ?? "",
      full_name: user.fullName,
      faculty: user.faculty ?? "",
      department: user.department ?? "",
      phone: user.phone ?? "",
      status: reg.status,
      registered_at_bangkok: toBangkokString(reg.registeredAt),
      waitlisted_at_bangkok: toBangkokString(reg.waitlistedAt),
      checked_in_at_bangkok: toBangkokString(reg.checkedInAt),
      cancelled_at_bangkok: toBangkokString(reg.cancelledAt),
    }));

    const csv = toCsv(records, [
      "registration_id",
      "email",
      "student_id",
      "full_name",
      "faculty",
      "department",
      "phone",
      "status",
      "registered_at_bangkok",
      "waitlisted_at_bangkok",
      "checked_in_at_bangkok",
      "cancelled_at_bangkok",
    ]);
    await auditExport(c, eventId, "registrations_summary", records.length);
    return csvResponse(c, `event-${eventId}-registrations-summary.csv`, csv, records.length);
  },
);

// GET /admin/events/:eventId/export/registrations-full — summary + flattened answers + file id/secure link (never binary).
router.get(
  "/admin/events/:eventId/export/registrations-full",
  ...adminOnly,
  zValidator("query", exportFiltersSchema),
  async (c) => {
    const eventId = c.req.param("eventId");
    await requireEvent(eventId);
    const f = c.req.valid("query");

    const base = await fetchBase(eventId, f);
    const regIds = base.map((b) => b.reg.id);

    // Pull all answers + live files for the matched registrations in one go.
    const answers = regIds.length
      ? await db
          .select({
            registrationId: registrationFormAnswers.registrationId,
            fieldKey: registrationFormAnswers.fieldKey,
            value: registrationFormAnswers.value,
          })
          .from(registrationFormAnswers)
          .where(inArray(registrationFormAnswers.registrationId, regIds))
      : [];
    const files = regIds.length
      ? await db
          .select({
            id: uploadedFiles.id,
            registrationId: uploadedFiles.registrationId,
            fieldKey: uploadedFiles.formFieldKey,
            filename: uploadedFiles.originalFilename,
          })
          .from(uploadedFiles)
          .where(and(inArray(uploadedFiles.registrationId, regIds), isNull(uploadedFiles.deletedAt)))
      : [];

    // Group answers/files per registration; collect every field key seen for stable columns.
    const answersByReg = new Map<string, Record<string, unknown>>();
    const fieldKeys = new Set<string>();
    for (const a of answers) {
      fieldKeys.add(`answer_${a.fieldKey}`);
      const m = answersByReg.get(a.registrationId) ?? {};
      m[`answer_${a.fieldKey}`] = serializeAnswer(a.value);
      answersByReg.set(a.registrationId, m);
    }
    const filesByReg = new Map<string, Record<string, { id: string; filename: string }>>();
    for (const fl of files) {
      const m = filesByReg.get(fl.registrationId) ?? {};
      m[fl.fieldKey] = { id: fl.id, filename: fl.filename };
      filesByReg.set(fl.registrationId, m);
      fieldKeys.add(`file_${fl.fieldKey}_id`);
      fieldKeys.add(`file_${fl.fieldKey}_link`);
    }

    const records = base.map(({ reg, user }) => {
      const rec: Record<string, unknown> = {
        registration_id: reg.id,
        email: user.email,
        student_id: user.studentId ?? "",
        full_name: user.fullName,
        faculty: user.faculty ?? "",
        department: user.department ?? "",
        phone: user.phone ?? "",
        status: reg.status,
        form_version_id: reg.formVersionId ?? "",
        registered_at_bangkok: toBangkokString(reg.registeredAt),
        checked_in_at_bangkok: toBangkokString(reg.checkedInAt),
        cancelled_at_bangkok: toBangkokString(reg.cancelledAt),
      };
      Object.assign(rec, answersByReg.get(reg.id) ?? {});
      // File columns = id + secure download link (backend endpoint), NEVER binary content.
      const regFiles = filesByReg.get(reg.id) ?? {};
      for (const [fk, fl] of Object.entries(regFiles)) {
        rec[`file_${fk}_id`] = fl.id;
        rec[`file_${fk}_link`] = `/files/${fl.id}/download`;
      }
      return rec;
    });

    const baseCols = [
      "registration_id",
      "email",
      "student_id",
      "full_name",
      "faculty",
      "department",
      "phone",
      "status",
      "form_version_id",
      "registered_at_bangkok",
      "checked_in_at_bangkok",
      "cancelled_at_bangkok",
    ];
    const columns = [...baseCols, ...Array.from(fieldKeys).sort()];
    const csv = toCsv(records, columns);
    await auditExport(c, eventId, "registrations_full", records.length);
    return csvResponse(c, `event-${eventId}-registrations-full.csv`, csv, records.length);
  },
);

// GET /admin/events/:eventId/export/checkin-attendance — check-in oriented view (who attended, when, how).
router.get(
  "/admin/events/:eventId/export/checkin-attendance",
  ...adminOnly,
  zValidator("query", exportFiltersSchema),
  async (c) => {
    const eventId = c.req.param("eventId");
    await requireEvent(eventId);
    const f = c.req.valid("query");

    const base = await fetchBase(eventId, f);
    const records = base.map(({ reg, user }) => ({
      registration_id: reg.id,
      email: user.email,
      student_id: user.studentId ?? "",
      full_name: user.fullName,
      faculty: user.faculty ?? "",
      department: user.department ?? "",
      status: reg.status,
      attended: reg.status === "checked_in" ? "yes" : "no",
      checked_in_at_bangkok: toBangkokString(reg.checkedInAt),
      checkin_method: reg.checkinMethod ?? "",
      checked_in_by_user_id: reg.checkedInByUserId ?? "",
      manual_checkin_reason: reg.manualCheckinReason ?? "",
    }));

    const csv = toCsv(records, [
      "registration_id",
      "email",
      "student_id",
      "full_name",
      "faculty",
      "department",
      "status",
      "attended",
      "checked_in_at_bangkok",
      "checkin_method",
      "checked_in_by_user_id",
      "manual_checkin_reason",
    ]);
    await auditExport(c, eventId, "checkin_attendance", records.length);
    return csvResponse(c, `event-${eventId}-checkin-attendance.csv`, csv, records.length);
  },
);

// Flatten an answer jsonb value into a single CSV cell.
function serializeAnswer(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default router;
