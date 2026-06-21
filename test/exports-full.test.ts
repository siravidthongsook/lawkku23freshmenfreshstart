import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import {
  registrations,
  registrationFormAnswers,
} from "../src/db/schema/registrations";
import { uploadedFiles } from "../src/db/schema/files";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function parseCsv(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  }).data;
}

// Seed an active registration form version with a multi-type schema (incl. a file_upload field).
// The export only reads field KEYS off the answer/file rows, so the schema's exact shape is not
// load-bearing for column generation — but we keep it realistic for intent clarity.
async function seedFormVersion(eventId: string, adminId: string) {
  const schemaJson = {
    fields: [
      { key: "nickname", type: "short_text", label: "Nickname", required: false },
      { key: "shirt_size", type: "single_choice", label: "Shirt", required: true },
      {
        key: "diet",
        type: "multiple_choice",
        label: "Dietary",
        required: false,
      },
      {
        key: "id_card",
        type: "file_upload",
        label: "ID Card",
        required: true,
      },
    ],
  };
  const [row] = await db
    .insert(eventFormVersions)
    .values({
      eventId,
      formType: "registration",
      versionNumber: 1,
      schemaJson,
      createdByAdminId: adminId,
    })
    .returning();
  if (!row) throw new Error("seedFormVersion: insert returned no row");
  return row;
}

// Insert a uploaded_files row directly (the export reads id/field/filename; no real storage needed).
async function seedUploadedFile(opts: {
  ownerUserId: string;
  eventId: string;
  registrationId: string;
  formVersionId: string;
  fieldKey: string;
  filename: string;
}) {
  const [row] = await db
    .insert(uploadedFiles)
    .values({
      ownerUserId: opts.ownerUserId,
      eventId: opts.eventId,
      registrationId: opts.registrationId,
      formVersionId: opts.formVersionId,
      formFieldKey: opts.fieldKey,
      originalFilename: opts.filename,
      storedObjectKey: `private/${opts.registrationId}/${opts.fieldKey}`,
      mimeType: "application/pdf",
      fileSizeBytes: 1234,
      checksumSha256: "a".repeat(64),
    })
    .returning();
  if (!row) throw new Error("seedUploadedFile: insert returned no row");
  return row;
}

// ---------------------------------------------------------------------------
// registrations-full export — dynamic answer/file column generation
// ---------------------------------------------------------------------------

describe("export: registrations-full (dynamic answer + file columns)", () => {
  it("generates answer_<key> columns per field, serializes array answers, and emits file id + secure link (never binary)", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const form = await seedFormVersion(event.id, admin.id);

    // A student registered with a mix of answer types + an uploaded file.
    const student = await seedUser({ role: "student", fullName: "Ann Swer" });
    const reg = await makeRegistration({
      event,
      user: student,
      status: "registered",
    });
    // Bind the form version to the registration so form_version_id surfaces.
    await db
      .update(registrations)
      .set({ formVersionId: form.id })
      .where(eq(registrations.id, reg.id));

    // Answers: a scalar, and an ARRAY (multiple_choice) → serializeAnswer joins with "; ".
    await db.insert(registrationFormAnswers).values([
      {
        registrationId: reg.id,
        formVersionId: form.id,
        fieldKey: "nickname",
        value: "Annie",
      },
      {
        registrationId: reg.id,
        formVersionId: form.id,
        fieldKey: "shirt_size",
        value: "M",
      },
      {
        registrationId: reg.id,
        formVersionId: form.id,
        fieldKey: "diet",
        value: ["vegan", "halal"], // array → "vegan; halal"
      },
    ]);
    // Uploaded file answer for the file_upload field.
    const file = await seedUploadedFile({
      ownerUserId: student.id,
      eventId: event.id,
      registrationId: reg.id,
      formVersionId: form.id,
      fieldKey: "id_card",
      filename: "card.pdf",
    });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-full`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const header = (text.split(/\r?\n/)[0] ?? "").split(",");
    const rows = parseCsv(text);
    const row = rows.find((r) => r.registration_id === reg.id)!;
    expect(row).toBeDefined();

    // Dynamic answer columns exist, one per answered field.
    expect(header).toContain("answer_nickname");
    expect(header).toContain("answer_shirt_size");
    expect(header).toContain("answer_diet");
    // Scalar answers carried through verbatim.
    expect(row.answer_nickname).toBe("Annie");
    expect(row.answer_shirt_size).toBe("M");
    // Array answer serialized via serializeAnswer (routes.ts ~284) → "; " joined.
    expect(row.answer_diet).toBe("vegan; halal");

    // File columns: id + secure link, NOT binary content (CLAUDE.md invariant).
    expect(header).toContain("file_id_card_id");
    expect(header).toContain("file_id_card_link");
    expect(row.file_id_card_id).toBe(file.id);
    // Link points at the authorized backend download endpoint.
    expect(row.file_id_card_link).toBe(`/files/${file.id}/download`);
    // Invariant: only the id + link travel — no filename, no bytes, no storage key.
    expect(text).not.toContain("card.pdf");
    expect(text).not.toContain("private/");
  });

  it("serializes an OBJECT answer value as JSON (serializeAnswer object branch)", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const form = await seedFormVersion(event.id, admin.id);
    const student = await seedUser({ role: "student" });
    const reg = await makeRegistration({ event, user: student, status: "registered" });

    // Object value → JSON.stringify (covers the typeof === "object" non-array branch).
    await db.insert(registrationFormAnswers).values({
      registrationId: reg.id,
      formVersionId: form.id,
      fieldKey: "address",
      value: { city: "KKU", zip: "40002" },
    });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-full`,
      { cookie },
    );
    const rows = parseCsv(await res.text());
    const row = rows.find((r) => r.registration_id === reg.id)!;
    // jsonb may reorder object keys → assert structural equality, not exact string.
    expect(JSON.parse(row.answer_address)).toEqual({ city: "KKU", zip: "40002" });
  });

  it("leaves a blank cell for a registrant with no answer to an optional field", async () => {
    // Two registrants share the event. Only reg A answers "nickname"; reg B never does.
    // The column is generated globally (from any seen key) but B's cell stays blank.
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const form = await seedFormVersion(event.id, admin.id);

    const studentA = await seedUser({ role: "student", fullName: "Has Answer" });
    const studentB = await seedUser({ role: "student", fullName: "No Answer" });
    const regA = await makeRegistration({ event, user: studentA, status: "registered" });
    const regB = await makeRegistration({ event, user: studentB, status: "registered" });

    await db.insert(registrationFormAnswers).values({
      registrationId: regA.id,
      formVersionId: form.id,
      fieldKey: "nickname",
      value: "OnlyMe",
    });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-full`,
      { cookie },
    );
    const text = await res.text();
    const header = (text.split(/\r?\n/)[0] ?? "").split(",");
    expect(header).toContain("answer_nickname"); // column exists globally

    const rows = parseCsv(text);
    const a = rows.find((r) => r.registration_id === regA.id)!;
    const b = rows.find((r) => r.registration_id === regB.id)!;
    expect(a.answer_nickname).toBe("OnlyMe");
    expect(b.answer_nickname).toBe(""); // optional field unanswered → blank cell
  });
});
