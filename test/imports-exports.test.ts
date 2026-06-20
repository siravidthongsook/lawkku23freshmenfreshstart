import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { registrations } from "../src/db/schema/registrations";
import { userImports } from "../src/db/schema/imports";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import { toBangkokString } from "../src/lib/time";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

// Upload a CSV to the preview endpoint as multipart/form-data (field name `file`,
// matching c.req.parseBody() reading body.file). Returns the raw Response.
function previewCsv(
  csv: string,
  cookie: string,
  extra: Record<string, string> = {},
  filename = "import.csv",
): Promise<Response> {
  const fd = new FormData();
  fd.set("file", new File([csv], filename, { type: "text/csv" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return request("/admin/imports/users/preview", { method: "POST", cookie, body: fd });
}

// Parse CSV text into an array of row objects keyed by header.
function parseCsv(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
}

// ---------------------------------------------------------------------------
// User import (CSV) — two-step preview → confirm flow
// ---------------------------------------------------------------------------

describe("user import: preview", () => {
  it("rejects non-CSV file type", async () => {
    const { cookie } = await loginAs("admin");
    const res = await previewCsv("email,full_name\na@b.test,A", cookie, {}, "import.txt");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unsupported_file_type");
    expect(body.message).toBeTruthy();
  });

  it("rejects an empty (header-only) CSV", async () => {
    const { cookie } = await loginAs("admin");
    const res = await previewCsv("email,full_name\n", cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_file");
  });

  it("rejects when file field is missing entirely", async () => {
    const { cookie } = await loginAs("admin");
    const fd = new FormData();
    fd.set("scope", "user_pool_only");
    const res = await request("/admin/imports/users/preview", {
      method: "POST",
      cookie,
      body: fd,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_file");
  });

  it("classifies valid / invalid / duplicate rows and never silently drops them", async () => {
    const { cookie } = await loginAs("admin");
    // Rows: 1 valid create, 1 missing full_name (invalid), 1 invalid email,
    // 1 in-file duplicate email, 1 in-file duplicate student_id.
    const csv = [
      "email,full_name,student_id",
      "alice@b.test,Alice,s001",
      "noname@b.test,,s002", // invalid: missing full name
      "not-an-email,Bob,s003", // invalid: bad email
      "alice@b.test,Alice Two,s004", // duplicate_email (repeat in file)
      "carol@b.test,Carol,s001", // duplicate_student_id (repeat in file)
    ].join("\n");
    const res = await previewCsv(csv, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      importId: string;
      counts: Record<string, number>;
      rows: { rowNumber: number; status: string; note?: string }[];
    };

    // All 5 rows reported — nothing dropped.
    expect(body.rows.length).toBe(5);
    expect(body.counts.total).toBe(5);

    const byNum = new Map(body.rows.map((r) => [r.rowNumber, r]));
    expect(byNum.get(1)?.status).toBe("will_create");
    expect(byNum.get(2)?.status).toBe("invalid"); // missing full name
    expect(byNum.get(3)?.status).toBe("invalid"); // invalid email
    expect(byNum.get(4)?.status).toBe("duplicate_email");
    expect(byNum.get(5)?.status).toBe("duplicate_student_id");

    expect(body.counts.invalid).toBe(2);
    expect(body.counts.duplicate_email).toBe(1);
    expect(body.counts.duplicate_student_id).toBe(1);
    expect(body.counts.will_create).toBe(1);

    // Preview must NOT create any user yet.
    const created = await db.select().from(users).where(eq(users.email, "alice@b.test"));
    expect(created.length).toBe(0);

    // A previewed batch row is persisted.
    const [batch] = await db
      .select()
      .from(userImports)
      .where(eq(userImports.id, body.importId));
    expect(batch?.status).toBe("previewed");
  });

  it("flags existing users as will_update vs new as will_create", async () => {
    const { cookie } = await loginAs("admin");
    // Seed an existing student by email so the importer sees it.
    await seedUser({ role: "student", email: "existing@b.test", studentId: "exist-1" });
    const csv = [
      "email,full_name,student_id",
      "existing@b.test,Existing Updated,exist-1",
      "fresh@b.test,Fresh,fresh-1",
    ].join("\n");
    const res = await previewCsv(csv, cookie);
    const body = (await res.json()) as { rows: { rowNumber: number; status: string }[] };
    const byNum = new Map(body.rows.map((r) => [r.rowNumber, r]));
    expect(byNum.get(1)?.status).toBe("will_update");
    expect(byNum.get(2)?.status).toBe("will_create");
  });
});

describe("user import: confirm (commit)", () => {
  it("creates users with correct fields + temp password, stores UTC timestamps, reflects counts", async () => {
    const { cookie } = await loginAs("admin");
    const csv = [
      "email,full_name,student_id,faculty,department,phone",
      "newone@b.test,New One,n001,Law,Civil,0810000001",
      "newtwo@b.test,New Two,n002,Law,Criminal,0810000002",
    ].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId, scope: "user_pool_only" },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { created: number; updated: number };
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);

    // Fields persisted correctly + role student + must-change flag.
    const [u] = await db.select().from(users).where(eq(users.email, "newone@b.test"));
    expect(u?.fullName).toBe("New One");
    expect(u?.studentId).toBe("n001");
    expect(u?.faculty).toBe("Law");
    expect(u?.department).toBe("Civil");
    expect(u?.phone).toBe("0810000001");
    expect(u?.role).toBe("student");
    expect(u?.passwordMustChange).toBe(true);
    // createdAt is a real Date (timestamptz → UTC at rest); driver returns a Date object.
    expect(u?.createdAt).toBeInstanceOf(Date);

    // Confirmed batch reflects counts in result_summary.
    const [batch] = await db
      .select()
      .from(userImports)
      .where(eq(userImports.id, importId));
    expect(batch?.status).toBe("confirmed");
    const summary = batch?.resultSummary as { counts: Record<string, number> };
    expect(summary.counts.created).toBe(2);
  });

  it("registers imported users to a target event when scope = register_to_event", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const csv = ["email,full_name", "reg1@b.test,Reg One"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    expect(prev.status).toBe(200);
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: {
        importId,
        scope: "user_pool_and_register_to_event",
        targetEventId: event.id,
      },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { created: number; registered: number };
    expect(result.created).toBe(1);
    expect(result.registered).toBe(1);

    // A registration row exists for the new user in the target event.
    const [u] = await db.select().from(users).where(eq(users.email, "reg1@b.test"));
    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, u!.id)));
    expect(regs.length).toBe(1);
    expect(regs[0]?.status).toBe("registered");
    expect(regs[0]?.registeredAt).toBeInstanceOf(Date);
  });

  it("BUG B: confirm is bound to the PREVIEWED batch — body scope/targetEventId cannot escalate", async () => {
    // Preview as user_pool_only (no capacity analysis). Then try to confirm with a body that
    // escalates to register-to-event B. Confirm must derive scope/event from the batch and ignore
    // the body → NO registration is created (preview-bypass is impossible).
    const { cookie, user: admin } = await loginAs("admin");
    const eventB = await makeEvent({ createdByAdminId: admin.id });
    const csv = ["email,full_name", "escalate@b.test,Escalate Me"].join("\n");
    const prev = await previewCsv(csv, cookie); // scope defaults to user_pool_only
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      // Malicious body attempting to register to an event the preview never analyzed.
      body: {
        importId,
        scope: "user_pool_and_register_to_event",
        targetEventId: eventB.id,
      },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { created: number; registered: number };
    expect(result.created).toBe(1);
    expect(result.registered).toBe(0); // body scope IGNORED — user_pool_only honored

    // No registration row was created in event B.
    const [u] = await db.select().from(users).where(eq(users.email, "escalate@b.test"));
    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventB.id), eq(registrations.userId, u!.id)));
    expect(regs.length).toBe(0);
  });

  it("rejects confirm when batch is not in previewed state (double confirm)", async () => {
    const { cookie } = await loginAs("admin");
    const csv = ["email,full_name", "dbl@b.test,Double"].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };

    const first = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId, scope: "user_pool_only" },
    });
    expect(first.status).toBe(200);

    const second = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId, scope: "user_pool_only" },
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
  });

  it("returns 404 confirming a non-existent import batch", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: {
        importId: "00000000-0000-0000-0000-000000000000",
        scope: "user_pool_only",
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("user import: result endpoint (GET /admin/imports/:id/result)", () => {
  it("PREVIEW result CSV reports every row incl. invalid/duplicate (not dropped)", async () => {
    // Before confirm, the result endpoint exposes summary.rows = ALL computed rows.
    const { cookie } = await loginAs("admin");
    const csv = [
      "email,full_name,student_id",
      "okrow@b.test,Ok Row,r001",
      "badrow,Bad Row,r002", // invalid email
    ].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };

    const res = await request(`/admin/imports/${importId}/result`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const rows = parseCsv(await res.text());

    // Both rows present at preview time — malformed reported, not silently dropped.
    expect(rows.length).toBe(2);
    const ok = rows.find((r) => r.email === "okrow@b.test");
    const bad = rows.find((r) => r.email === "badrow");
    expect(ok?.status).toBe("will_create");
    expect(bad?.status).toBe("invalid");
    expect(bad?.note).toBeTruthy(); // reason surfaced
  });

  it("CONFIRMED result CSV lists created rows; temp_password column ABSENT by default (no leak)", async () => {
    // SECURITY (BUG A fix): the default result download NEVER carries plaintext temp passwords.
    // The temp_password column is omitted entirely unless the caller opts in (see next test).
    // After confirm, the endpoint reads summary.result, which only holds created/updated/
    // skipped_not_found rows. Invalid/duplicate rows are NOT carried into the confirmed result CSV.
    const { cookie } = await loginAs("admin");
    const csv = [
      "email,full_name,student_id",
      "okrow@b.test,Ok Row,r001",
      "badrow,Bad Row,r002", // invalid email → dropped from confirmed result rows
    ].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };
    await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });

    const res = await request(`/admin/imports/${importId}/result`, { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    const header = text.split(/\r?\n/)[0] ?? "";
    // Default download carries NO temp_password column → plaintext can never leak.
    expect(header).not.toContain("temp_password");
    const rows = parseCsv(text);

    // Only the created row is present in the confirmed-result CSV.
    expect(rows.length).toBe(1);
    const ok = rows.find((r) => r.email === "okrow@b.test");
    expect(ok?.status).toBe("will_create");
    expect(ok?.result).toBe("created");
    expect(ok?.temp_password).toBeUndefined(); // column absent in the default (non-opt-in) download
    // The invalid row is absent here, but its count survives in result_summary.
    expect(rows.find((r) => r.email === "badrow")).toBeUndefined();
  });

  it("CONFIRMED result reveals temp_password ONLY with opt-in + reason (mirrors users-export reveal)", async () => {
    // SECURITY (BUG A fix): plaintext temp pw is decrypted on demand from the encrypted store,
    // requires include_temp_password=true AND a reason, and is audited (import_result_revealed).
    const { cookie } = await loginAs("admin");
    const csv = ["email,full_name,student_id", "reveal@b.test,Reveal Me,rv001"].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };
    await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });

    // Opt-in WITHOUT reason → 400 reason_required (guard fires before any CSV/audit).
    const noReason = await request(
      `/admin/imports/${importId}/result?include_temp_password=true`,
      { cookie },
    );
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as { error: string }).error).toBe("reason_required");

    // Opt-in WITH reason → temp_password column present + a non-empty value for the created row.
    const revealed = await request(
      `/admin/imports/${importId}/result?include_temp_password=true&reason=handover%20to%20student`,
      { cookie },
    );
    expect(revealed.status).toBe(200);
    const text = await revealed.text();
    expect(text.split(/\r?\n/)[0]).toContain("temp_password");
    const rows = parseCsv(text);
    const me = rows.find((r) => r.email === "reveal@b.test");
    expect(me?.temp_password).toBeTruthy(); // decrypted on demand from encrypted store
  });

  it("CONFIRMED result_summary NEVER persists plaintext temp passwords (encrypted store is truth)", async () => {
    // SECURITY (BUG A fix): result_summary.result rows carry only userId, never the plaintext secret.
    const { cookie } = await loginAs("admin");
    const csv = ["email,full_name,student_id", "noplain@b.test,No Plain,np001"].join("\n");
    const prev = await previewCsv(csv, cookie);
    const { importId } = (await prev.json()) as { importId: string };
    await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });

    const [batch] = await db.select().from(userImports).where(eq(userImports.id, importId));
    const stored = JSON.stringify(batch?.resultSummary ?? {});
    // No tempPassword key persisted anywhere in the stored summary.
    expect(stored).not.toContain("tempPassword");
    const summary = batch?.resultSummary as { result?: { userId?: string }[] };
    expect(summary.result?.[0]?.userId).toBeTruthy(); // userId stored for on-demand decrypt
  });

  it("returns 404 for an unknown import id", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request(
      "/admin/imports/00000000-0000-0000-0000-000000000000/result",
      { cookie },
    );
    expect(res.status).toBe(404);
  });
});

describe("user import: authorization", () => {
  it("forbids non-admin from preview", async () => {
    const { cookie } = await loginAs("student");
    const res = await previewCsv("email,full_name\na@b.test,A", cookie);
    expect(res.status).toBe(403);
  });

  it("requires auth for the result endpoint", async () => {
    const res = await request(
      "/admin/imports/00000000-0000-0000-0000-000000000000/result",
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Exports — registrations-summary, registrations-full, checkin-attendance
// ---------------------------------------------------------------------------

describe("export: registrations-summary", () => {
  it("returns CSV with correct rows and counts for registered + checked_in", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });

    // Two registered, one checked_in, one cancelled → 4 total rows.
    const reg1 = await seedUser({ role: "student", fullName: "Stu One" });
    const reg2 = await seedUser({ role: "student", fullName: "Stu Two" });
    const chk = await seedUser({ role: "student", fullName: "Stu Checked" });
    const can = await seedUser({ role: "student", fullName: "Stu Cancelled" });
    await makeRegistration({ event, user: reg1, status: "registered" });
    await makeRegistration({ event, user: reg2, status: "registered" });
    await makeRegistration({ event, user: chk, status: "checked_in" });
    await makeRegistration({ event, user: can, status: "cancelled" });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("x-row-count")).toBe("4");

    const rows = parseCsv(await res.text());
    expect(rows.length).toBe(4);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["cancelled", "checked_in", "registered", "registered"]);
    // Identity columns present.
    const names = rows.map((r) => r.full_name).sort();
    expect(names).toContain("Stu Checked");
  });

  it("does NOT leak password hashes or temp passwords in exported columns", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    await makeRegistration({ event, status: "registered" });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    const text = await res.text();
    const header = text.split(/\r?\n/)[0] ?? "";
    // No secret-bearing columns in the header.
    expect(header).not.toMatch(/password|hash|token|secret/i);
    // The actual argon2 hash prefix must never appear in the body.
    expect(text).not.toContain("$argon2");
  });

  it("filters by status query param", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    await makeRegistration({ event, status: "registered" });
    await makeRegistration({ event, status: "checked_in" });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary?status=checked_in`,
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-row-count")).toBe("1");
    const rows = parseCsv(await res.text());
    expect(rows.every((r) => r.status === "checked_in")).toBe(true);
  });

  it("returns 404 for an unknown event", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request(
      "/admin/events/00000000-0000-0000-0000-000000000000/export/registrations-summary",
      { cookie },
    );
    expect(res.status).toBe(404);
  });

  it("forbids non-admin", async () => {
    const { cookie } = await loginAs("student");
    const event = await makeEvent();
    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    expect(res.status).toBe(403);
  });
});

describe("export: Bangkok-labeled timestamp columns (UTC stored, +07:00 exported)", () => {
  it("labels timestamp columns with _bangkok and converts a known UTC instant to +07:00", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });

    // Known UTC instant: 2026-06-19T03:30:00Z → Bangkok 2026-06-19 10:30:00 +07:00.
    const knownUtc = new Date("2026-06-19T03:30:00.000Z");
    const reg = await makeRegistration({
      event,
      status: "checked_in",
      registeredAt: knownUtc,
    });
    // Set checked_in_at directly to the known UTC instant (factory doesn't set it).
    await db
      .update(registrations)
      .set({ checkedInAt: knownUtc })
      .where(eq(registrations.id, reg.id));

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    const text = await res.text();
    const header = (text.split(/\r?\n/)[0] ?? "").split(",");

    // Header naming invariant: timestamp columns carry the _bangkok suffix.
    expect(header).toContain("registered_at_bangkok");
    expect(header).toContain("checked_in_at_bangkok");
    expect(header).toContain("cancelled_at_bangkok");
    expect(header).toContain("waitlisted_at_bangkok");

    const rows = parseCsv(text);
    const row = rows[0]!;
    // Value invariant: matches the lib's Bangkok formatter for the known UTC instant.
    const expected = toBangkokString(knownUtc);
    expect(expected).toBe("2026-06-19 10:30:00 +07:00"); // sanity-check the lib computation
    expect(row.checked_in_at_bangkok).toBe(expected);
    expect(row.registered_at_bangkok).toBe(expected);

    // DB still stores UTC: re-read the row and confirm the instant is unchanged.
    const [stored] = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, reg.id));
    expect(stored?.checkedInAt?.toISOString()).toBe("2026-06-19T03:30:00.000Z");
  });

  it("renders empty cell for null timestamps", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    // cancelled reg with registeredAt = null (factory sets null for non-active).
    await makeRegistration({ event, status: "cancelled" });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    const rows = parseCsv(await res.text());
    expect(rows[0]?.registered_at_bangkok).toBe(""); // null → empty string
    expect(rows[0]?.checked_in_at_bangkok).toBe("");
  });
});

describe("export: checkin-attendance", () => {
  it("marks attended yes/no by status and exposes Bangkok checkin time", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const knownUtc = new Date("2026-06-19T03:30:00.000Z");

    const reg = await makeRegistration({ event, status: "checked_in" });
    await db
      .update(registrations)
      .set({ checkedInAt: knownUtc })
      .where(eq(registrations.id, reg.id));
    await makeRegistration({ event, status: "registered" });

    const res = await request(
      `/admin/events/${event.id}/export/checkin-attendance`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const header = (text.split(/\r?\n/)[0] ?? "").split(",");
    expect(header).toContain("attended");
    expect(header).toContain("checked_in_at_bangkok");

    const rows = parseCsv(text);
    const attended = rows.find((r) => r.status === "checked_in");
    const notAttended = rows.find((r) => r.status === "registered");
    expect(attended?.attended).toBe("yes");
    expect(attended?.checked_in_at_bangkok).toBe(toBangkokString(knownUtc));
    expect(notAttended?.attended).toBe("no");
  });
});

describe("export: registrations-full", () => {
  it("returns CSV with identity + status columns and never leaks secrets", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    await makeRegistration({ event, status: "registered" });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-full`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const header = (text.split(/\r?\n/)[0] ?? "");
    expect(header).toContain("checked_in_at_bangkok");
    expect(header).not.toMatch(/password|hash|token|secret/i);
    expect(text).not.toContain("$argon2");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: import a CSV, then export and confirm key fields survive
// ---------------------------------------------------------------------------

describe("import → export round-trip", () => {
  it("imported + registered users appear in the export with matching identity fields", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const csv = [
      "email,full_name,student_id,faculty,department,phone",
      "rt1@b.test,Round Trip,rt-001,Law,Public,0820000001",
    ].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const { importId } = (await prev.json()) as { importId: string };
    await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: {
        importId,
        scope: "user_pool_and_register_to_event",
        targetEventId: event.id,
      },
    });

    const res = await request(
      `/admin/events/${event.id}/export/registrations-summary`,
      { cookie },
    );
    const rows = parseCsv(await res.text());
    const me = rows.find((r) => r.email === "rt1@b.test");
    expect(me).toBeDefined();
    expect(me?.full_name).toBe("Round Trip");
    expect(me?.student_id).toBe("rt-001");
    expect(me?.faculty).toBe("Law");
    expect(me?.department).toBe("Public");
    expect(me?.phone).toBe("0820000001");
    expect(me?.status).toBe("registered");
  });
});
