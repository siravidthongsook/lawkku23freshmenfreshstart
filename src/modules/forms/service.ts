import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { eventFormVersions } from "../../db/schema/forms";
import { registrations, registrationFormAnswers } from "../../db/schema/registrations";
import { assessmentAnswers } from "../../db/schema/assessments";
import type { FormType } from "../../lib/form-schema";
import type { FormField, FormSchema } from "../../lib/form-schema";

// Active form version for an event of a given type (at most one is_active=true per (event, formType)).
// formType defaults to 'registration' so all existing registration-form callers are unchanged.
export async function getActiveVersion(eventId: string, formType: FormType = "registration") {
  const [row] = await db
    .select()
    .from(eventFormVersions)
    .where(
      and(
        eq(eventFormVersions.eventId, eventId),
        eq(eventFormVersions.formType, formType),
        eq(eventFormVersions.isActive, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

// True if any stored data references this form version — registration answers/regs OR assessment answers.
// Used to decide whether a structural edit must fork a new version (in-place edit would corrupt those refs),
// regardless of registration status (cancelled regs still hold answers we must not mutate).
export async function versionIsReferenced(
  exec: Tx | typeof db,
  formVersionId: string,
): Promise<boolean> {
  const [ans] = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(registrationFormAnswers)
    .where(eq(registrationFormAnswers.formVersionId, formVersionId));
  if ((ans?.c ?? 0) > 0) return true;

  const [reg] = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.formVersionId, formVersionId));
  if ((reg?.c ?? 0) > 0) return true;

  // Assessment forms reuse this versioning machinery — count their answers too, else an
  // assessment form with submissions could be wrongly edited in place (corrupting stored answers).
  const [asmt] = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(assessmentAnswers)
    .where(eq(assessmentAnswers.formVersionId, formVersionId));
  return (asmt?.c ?? 0) > 0;
}

// Index fields by stable key for structural comparison.
function indexByKey(fields: FormField[]): Map<string, FormField> {
  const m = new Map<string, FormField>();
  for (const f of fields) m.set(f.key, f);
  return m;
}

// STRUCTURAL change = add/remove field, or change type/key/options/required on an existing field.
// SAFE change = label/help/sort only. Returns true when the diff is structural.
export function isStructuralChange(oldSchema: FormSchema, newSchema: FormSchema): boolean {
  const oldFields = indexByKey(oldSchema.fields);
  const newFields = indexByKey(newSchema.fields);

  // Added or removed keys → structural.
  if (oldFields.size !== newFields.size) return true;
  for (const key of oldFields.keys()) {
    if (!newFields.has(key)) return true; // removed
  }
  for (const key of newFields.keys()) {
    if (!oldFields.has(key)) return true; // added
  }

  // Per-field: type/required/options changes → structural (key already matched).
  for (const [key, oldF] of oldFields) {
    const newF = newFields.get(key)!;
    if (oldF.type !== newF.type) return true;
    if (oldF.required !== newF.required) return true;
    if (!sameOptions(oldF.options, newF.options)) return true;
  }
  return false; // only label/help/sort differ
}

function sameOptions(a?: string[], b?: string[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  // Order-sensitive compare — reordering options changes meaning for stored answers.
  return aa.every((v, i) => v === bb[i]);
}

// Create a new active version for one form type: deactivate the current active version OF THAT TYPE,
// insert incremented version_number. formType defaults to 'registration' (existing callers unchanged).
// version_number + is_active are both scoped per (event, formType) so registration and assessment
// forms keep independent version sequences and each can stay active simultaneously.
export async function createNewVersion(
  exec: Tx | typeof db,
  args: { eventId: string; schema: FormSchema; adminId: string; formType?: FormType },
) {
  const formType: FormType = args.formType ?? "registration";

  // Find current max version_number for (event, formType) — per-type sequence.
  const [maxRow] = await exec
    .select({ max: sql<number>`coalesce(max(${eventFormVersions.versionNumber}), 0)::int` })
    .from(eventFormVersions)
    .where(
      and(eq(eventFormVersions.eventId, args.eventId), eq(eventFormVersions.formType, formType)),
    );
  const nextVersion = (maxRow?.max ?? 0) + 1;

  // Deactivate any currently-active version OF THIS TYPE (leaves the other type's active version intact).
  await exec
    .update(eventFormVersions)
    .set({ isActive: false })
    .where(
      and(
        eq(eventFormVersions.eventId, args.eventId),
        eq(eventFormVersions.formType, formType),
        eq(eventFormVersions.isActive, true),
      ),
    );

  const [created] = await exec
    .insert(eventFormVersions)
    .values({
      eventId: args.eventId,
      formType,
      versionNumber: nextVersion,
      schemaJson: args.schema,
      createdByAdminId: args.adminId,
      isActive: true,
    })
    .returning();

  if (!created) throw new Error("form version insert returned no row"); // unreachable in practice
  return created;
}
