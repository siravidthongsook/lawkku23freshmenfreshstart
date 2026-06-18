import { and, desc, eq, sql } from "drizzle-orm";
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
export function validateAgainstVersion(version: EventFormVersion, answers: AnswerMap): AnswerMap {
  const schema = parseFormSchema(version);
  const result = validateAnswers(schema, answers);
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
export async function getRegistrationOrThrow(
  exec: Exec,
  registrationId: string,
): Promise<Registration> {
  const [reg] = await exec
    .select()
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
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
    cancelledAt: reg.cancelledAt?.toISOString() ?? null,
    checkinMethod: reg.checkinMethod,
    createdAt: reg.createdAt.toISOString(),
    updatedAt: reg.updatedAt.toISOString(),
  };
}
