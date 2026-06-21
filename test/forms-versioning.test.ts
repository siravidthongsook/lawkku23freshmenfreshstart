import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations, registrationFormAnswers } from "../src/db/schema/registrations";
import type { FormSchema } from "../src/lib/form-schema";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// Forms versioning invariant (forms/service.ts + PATCH routes.ts):
//  - safe edit (label/help/sort) on a referenced version → in-place, versioned:false, NO new row.
//  - structural edit while REFERENCED (a submitted answer exists) → FORK, versioned:true, old preserved.
//  - structural edit while NOT referenced → in-place (no fork).
// "Referenced" = any registration_form_answers row (or reg.form_version_id / assessment answer)
// points at the active version.

// A minimal 2-field registration schema we mutate in the structural-vs-safe tests.
const baseSchema: FormSchema = {
  fields: [
    { key: "full_name", type: "short_text", label: "Full name", required: true, sort: 0 },
    { key: "shirt", type: "short_text", label: "Shirt size", required: false, sort: 1 },
  ],
};

// Seed an active form version row directly for an event (the PATCH bootstrap path is exercised
// elsewhere; here we want a known starting version to mutate).
async function seedActiveVersion(eventId: string, adminId: string, schema: FormSchema) {
  const [row] = await db
    .insert(eventFormVersions)
    .values({
      eventId,
      formType: "registration",
      versionNumber: 1,
      schemaJson: schema,
      createdByAdminId: adminId,
      isActive: true,
    })
    .returning();
  return row!;
}

// Make a registration that REFERENCES a form version (stores an answer + sets form_version_id).
// This is what flips versionIsReferenced() → true.
async function makeReferencingRegistration(eventId: string, versionId: string) {
  const reg = await makeRegistration({
    event: { id: eventId } as never, // factory only reads event.id for the FK
    status: "registered",
  });
  await db
    .update(registrations)
    .set({ formVersionId: versionId })
    .where(eq(registrations.id, reg.id));
  await db.insert(registrationFormAnswers).values({
    registrationId: reg.id,
    formVersionId: versionId,
    fieldKey: "full_name",
    value: "Submitted Answer",
  });
  return reg;
}

// All active versions for an event (to assert the single-active invariant).
async function activeVersions(eventId: string) {
  return db
    .select()
    .from(eventFormVersions)
    .where(and(eq(eventFormVersions.eventId, eventId), eq(eventFormVersions.isActive, true)));
}

describe("forms versioning: PATCH /admin/events/:id/form", () => {
  it("SAFE edit on a referenced version → patches in place, versioned:false, no new version row", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const v1 = await seedActiveVersion(event.id, admin.id, baseSchema);
    await makeReferencingRegistration(event.id, v1.id); // now referenced

    // Only label/help/sort change — structurally identical.
    const safe: FormSchema = {
      fields: [
        { key: "full_name", type: "short_text", label: "Your full name", required: true, sort: 0 },
        { key: "shirt", type: "short_text", label: "T-shirt size", required: false, sort: 2 },
      ],
    };
    const res = await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie,
      body: { schema: safe },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versioned: boolean; form: { id: string } };
    expect(body.versioned).toBe(false);
    expect(body.form.id).toBe(v1.id); // same row, patched in place

    // No new version row was created — still exactly one version, still v1, now with new labels.
    const all = await db
      .select()
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, event.id));
    expect(all.length).toBe(1);
    const schema = all[0]!.schemaJson as FormSchema;
    expect(schema.fields.find((f) => f.key === "full_name")?.label).toBe("Your full name");
  });

  it("STRUCTURAL edit while REFERENCED → forks a new version, versioned:true, old preserved, single-active holds", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const v1 = await seedActiveVersion(event.id, admin.id, baseSchema);
    await makeReferencingRegistration(event.id, v1.id); // referenced → in-place would corrupt the answer

    // Structural: add a new required field.
    const structural: FormSchema = {
      fields: [
        ...baseSchema.fields,
        { key: "phone", type: "short_text", label: "Phone", required: true, sort: 2 },
      ],
    };
    const res = await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie,
      body: { schema: structural },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versioned: boolean;
      form: { id: string; versionNumber: number; isActive: boolean };
    };
    expect(body.versioned).toBe(true);
    expect(body.form.id).not.toBe(v1.id); // a NEW row
    expect(body.form.versionNumber).toBe(2);
    expect(body.form.isActive).toBe(true);

    // Two versions now exist; old v1 is untouched (deactivated, original schema intact).
    const all = await db
      .select()
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, event.id));
    expect(all.length).toBe(2);
    const old = all.find((r) => r.id === v1.id)!;
    expect(old.isActive).toBe(false);
    expect((old.schemaJson as FormSchema).fields.length).toBe(2); // no phone field — preserved

    // Single-active invariant: exactly one active version for the event.
    const active = await activeVersions(event.id);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(body.form.id);
  });

  it("STRUCTURAL edit while NOT referenced → edits in place (no fork), versioned:false", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const v1 = await seedActiveVersion(event.id, admin.id, baseSchema);
    // No registration/answers reference v1 → safe to mutate structure in place.

    const structural: FormSchema = {
      fields: [
        { key: "full_name", type: "short_text", label: "Full name", required: true, sort: 0 },
        // 'shirt' removed + 'age' added → clearly structural.
        { key: "age", type: "number", label: "Age", required: false, sort: 1 },
      ],
    };
    const res = await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie,
      body: { schema: structural },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versioned: boolean; form: { id: string } };
    expect(body.versioned).toBe(false); // not referenced → no new version
    expect(body.form.id).toBe(v1.id);

    // Still one version, now carrying the new structure.
    const all = await db
      .select()
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, event.id));
    expect(all.length).toBe(1);
    const keys = (all[0]!.schemaJson as FormSchema).fields.map((f) => f.key).sort();
    expect(keys).toEqual(["age", "full_name"]);
  });
});
