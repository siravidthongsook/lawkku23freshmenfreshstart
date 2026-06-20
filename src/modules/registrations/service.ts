import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Tx } from "../../db/client";
import { db } from "../../db/client";
import { events, type Event } from "../../db/schema/events";
import { eventFormVersions, type EventFormVersion } from "../../db/schema/forms";
import { uploadedFiles } from "../../db/schema/files";
import {
  registrationFormAnswers,
  registrations,
  type Registration,
} from "../../db/schema/registrations";
import { users } from "../../db/schema/users";
import { formSchema, type FormSchema, validateAnswers, type AnswerMap } from "../../lib/form-schema";
import { badRequest, notFound } from "../../lib/errors";

type Exec = Tx | typeof db;

// Load event or 404.
export async function getEventOrThrow(exec: Exec, eventId: string): Promise<Event> {
  const [event] = await exec.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw notFound("Event not found");
  return event;
}

// Capacity count = registered + checked_in only (excludes cancelled + waitlisted).
export async function countActiveRegistrations(exec: Exec, eventId: string): Promise<number> {
  const [row] = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        sql`${registrations.status} in ('registered','checked_in')`,
      ),
    );
  return row?.c ?? 0;
}

// Per-status registration counts for an event (all four statuses, default 0).
export async function countRegistrationsByStatus(
  eventId: string,
): Promise<{ registered: number; waitlisted: number; checked_in: number; cancelled: number }> {
  const counts = { registered: 0, waitlisted: 0, checked_in: 0, cancelled: 0 };
  const rows = await db
    .select({ status: registrations.status, c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .groupBy(registrations.status);
  for (const row of rows) counts[row.status] = row.c;
  return counts;
}

// Active form version for an event (the one new registrations bind to).
export async function getActiveFormVersion(
  exec: Exec,
  eventId: string,
): Promise<EventFormVersion | null> {
  const [row] = await exec
    .select()
    .from(eventFormVersions)
    .where(and(eq(eventFormVersions.eventId, eventId), eq(eventFormVersions.isActive, true)))
    .limit(1);
  return row ?? null;
}

// Load a specific form version (used for student edits that keep the registration's own version).
export async function getFormVersionById(
  exec: Exec,
  formVersionId: string,
): Promise<EventFormVersion | null> {
  const [row] = await exec
    .select()
    .from(eventFormVersions)
    .where(eq(eventFormVersions.id, formVersionId))
    .limit(1);
  return row ?? null;
}

// Parse stored schema_json into a typed FormSchema; throw if corrupt.
export function parseFormSchema(version: EventFormVersion): FormSchema {
  const parsed = formSchema.safeParse(version.schemaJson);
  if (!parsed.success) throw badRequest("form_schema_invalid", "Event form schema is invalid");
  return parsed.data;
}

// Validate submitted answers against a version's schema → normalized values or 400 with field errors.
// `allowMissingRequiredFiles` relaxes the required check for FILE fields only (admin manual register,
// where the registration — and thus file attach — doesn't exist yet).
export function validateAgainstVersion(
  version: EventFormVersion,
  answers: AnswerMap,
  opts?: { allowMissingRequiredFiles?: boolean },
): AnswerMap {
  const schema = parseFormSchema(version);
  const result = validateAnswers(schema, answers, opts);
  if (!result.ok) {
    const err = badRequest("invalid_form_answers", "Form answers failed validation");
    (err as unknown as { details: unknown }).details = result.errors;
    throw err;
  }
  return result.values;
}

// Upsert answer rows for a registration under a given form version.
export async function writeAnswers(
  exec: Exec,
  registrationId: string,
  formVersionId: string,
  values: AnswerMap,
): Promise<void> {
  for (const [fieldKey, value] of Object.entries(values)) {
    await exec
      .insert(registrationFormAnswers)
      .values({ registrationId, formVersionId, fieldKey, value: value ?? null })
      .onConflictDoUpdate({
        target: [registrationFormAnswers.registrationId, registrationFormAnswers.fieldKey],
        set: { value: value ?? null, updatedAt: new Date() },
      });
  }
}

// Answers map for a registration (field_key → value).
export async function getAnswers(
  exec: Exec,
  registrationId: string,
): Promise<Record<string, unknown>> {
  const rows = await exec
    .select({ fieldKey: registrationFormAnswers.fieldKey, value: registrationFormAnswers.value })
    .from(registrationFormAnswers)
    .where(eq(registrationFormAnswers.registrationId, registrationId));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.fieldKey] = r.value;
  return out;
}

// Active (non-deleted) file ids attached to a registration.
export async function getFileIds(exec: Exec, registrationId: string): Promise<string[]> {
  const rows = await exec
    .select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.registrationId, registrationId),
        sql`${uploadedFiles.deletedAt} is null`,
      ),
    );
  return rows.map((r) => r.id);
}

// Load registration or 404.
// forUpdate=true takes a row lock (FOR UPDATE) so concurrent status transitions serialize on a FRESH
// status — the loser blocks until the winner commits, then re-reads committed state. Must be in a tx.
export async function getRegistrationOrThrow(
  exec: Exec,
  registrationId: string,
  opts?: { forUpdate?: boolean },
): Promise<Registration> {
  const base = exec.select().from(registrations).where(eq(registrations.id, registrationId));
  const [reg] = await (opts?.forUpdate ? base.for("update") : base).limit(1);
  if (!reg) throw notFound("Registration not found");
  return reg;
}

// All registrations for a user, newest first.
export async function listUserRegistrations(userId: string): Promise<Registration[]> {
  return db
    .select()
    .from(registrations)
    .where(eq(registrations.userId, userId))
    .orderBy(desc(registrations.createdAt));
}

// Same as above but joined to the event so the student list can show which event each reg is for.
export async function listUserRegistrationsWithEvent(
  userId: string,
): Promise<{ registration: Registration; event: Event | null }[]> {
  const rows = await db
    .select({ registration: registrations, event: events })
    .from(registrations)
    .leftJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.userId, userId))
    .orderBy(desc(registrations.createdAt));
  return rows.map((r) => ({ registration: r.registration, event: r.event }));
}

// Serialize a registration row for API responses (UTC ISO timestamps).
export function serializeRegistration(reg: Registration) {
  return {
    id: reg.id,
    eventId: reg.eventId,
    userId: reg.userId,
    status: reg.status,
    formVersionId: reg.formVersionId,
    registeredAt: reg.registeredAt?.toISOString() ?? null,
    waitlistedAt: reg.waitlistedAt?.toISOString() ?? null,
    checkedInAt: reg.checkedInAt?.toISOString() ?? null,
    checkedOutAt: reg.checkedOutAt?.toISOString() ?? null,
    cancelledAt: reg.cancelledAt?.toISOString() ?? null,
    checkinMethod: reg.checkinMethod,
    createdAt: reg.createdAt.toISOString(),
    updatedAt: reg.updatedAt.toISOString(),
  };
}

// Identity fields joined onto a registration so admin UIs show WHO a registration belongs to
// (rather than a raw user_id UUID). Referenced by user_id only — never email/student_id (invariant).
type RegistrationIdentity = {
  studentId: string | null;
  fullName: string | null;
  email: string | null;
  faculty: string | null;
  department: string | null;
};

// Admin registration-list filters (server-side search/filter/pagination). Mirrors registration_status enum.
export type AdminRegistrationListParams = {
  q?: string; // matches student_id / email / full_name (ilike)
  status?: "registered" | "waitlisted" | "checked_in" | "cancelled";
  limit: number;
  offset: number;
};

// Serialized admin registration row = reg fields + user identity + checked-in-by name + form version number.
export type AdminRegistrationRow = ReturnType<typeof serializeRegistration> &
  RegistrationIdentity & {
    eventId: string;
    checkedInBy: string | null; // full name of the staff/admin who checked them in
    formVersion: number | null; // human-friendly version number, not the version UUID
  };

// List registrations for an event with user identity + check-in actor name + form version number.
// Server-side search/filter/pagination so the page scales past hundreds of rows. Returns { rows, total }.
export async function listEventRegistrationsForAdmin(
  eventId: string,
  params: AdminRegistrationListParams,
): Promise<{ rows: AdminRegistrationRow[]; total: number }> {
  const checkedInByUser = alias(users, "checked_in_by_user");

  const conds: SQL[] = [eq(registrations.eventId, eventId)];
  if (params.status) conds.push(eq(registrations.status, params.status));
  if (params.q) {
    const pat = `%${params.q}%`;
    const search = or(
      ilike(users.studentId, pat),
      ilike(users.email, pat),
      ilike(users.fullName, pat),
    );
    if (search) conds.push(search);
  }
  const where = and(...conds);

  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(where);
  const total = countRow?.c ?? 0;

  const rows = await db
    .select({
      reg: registrations,
      studentId: users.studentId,
      fullName: users.fullName,
      email: users.email,
      faculty: users.faculty,
      department: users.department,
      checkedInByName: checkedInByUser.fullName,
      formVersion: eventFormVersions.versionNumber,
    })
    .from(registrations)
    .innerJoin(users, eq(users.id, registrations.userId))
    .leftJoin(checkedInByUser, eq(checkedInByUser.id, registrations.checkedInByUserId))
    .leftJoin(eventFormVersions, eq(eventFormVersions.id, registrations.formVersionId))
    .where(where)
    .orderBy(desc(registrations.createdAt))
    .limit(params.limit)
    .offset(params.offset);

  return {
    rows: rows.map((r) => ({
      ...serializeRegistration(r.reg),
      studentId: r.studentId,
      fullName: r.fullName,
      email: r.email,
      faculty: r.faculty,
      department: r.department,
      checkedInBy: r.checkedInByName ?? null,
      formVersion: r.formVersion ?? null,
    })),
    total,
  };
}

// Load a registration's user identity (for the single-registration admin detail view).
export async function getRegistrationIdentity(
  exec: Exec,
  userId: string,
): Promise<RegistrationIdentity & { userId: string }> {
  const [u] = await exec
    .select({
      studentId: users.studentId,
      fullName: users.fullName,
      email: users.email,
      faculty: users.faculty,
      department: users.department,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    userId,
    studentId: u?.studentId ?? null,
    fullName: u?.fullName ?? null,
    email: u?.email ?? null,
    faculty: u?.faculty ?? null,
    department: u?.department ?? null,
  };
}

// User typeahead for the manual-register picker: match active students by student_id / email / full_name.
// Returns id + identity only (no auth state). Excludes already-registered (non-cancelled) users for this event.
export async function searchUsersForRegistration(
  eventId: string,
  q: string,
  limit: number,
): Promise<(RegistrationIdentity & { id: string })[]> {
  const pat = `%${q}%`;
  // Users who already hold a non-cancelled registration for this event — exclude from the picker.
  const taken = db
    .select({ userId: registrations.userId })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        inArray(registrations.status, ["registered", "waitlisted", "checked_in"]),
      ),
    );

  const rows = await db
    .select({
      id: users.id,
      studentId: users.studentId,
      fullName: users.fullName,
      email: users.email,
      faculty: users.faculty,
      department: users.department,
    })
    .from(users)
    .where(
      and(
        eq(users.status, "active"),
        or(ilike(users.studentId, pat), ilike(users.email, pat), ilike(users.fullName, pat)),
        sql`${users.id} not in ${taken}`,
      ),
    )
    .orderBy(users.fullName)
    .limit(limit);
  return rows;
}

// File metadata for the admin registration detail (filename + mime type, not just opaque id).
export async function getFiles(
  exec: Exec,
  registrationId: string,
): Promise<{ id: string; filename: string; mimeType: string }[]> {
  const rows = await exec
    .select({
      id: uploadedFiles.id,
      filename: uploadedFiles.originalFilename,
      mimeType: uploadedFiles.mimeType,
    })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.registrationId, registrationId),
        sql`${uploadedFiles.deletedAt} is null`,
      ),
    );
  return rows;
}
