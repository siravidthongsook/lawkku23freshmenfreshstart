import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { uploadedFiles } from "../src/db/schema/files";
import { resetDb, request } from "./helpers/db";
import { loginAs, seedUser, login } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIONS MATRIX — the single most valuable auth regression net.
//
// For every representative endpoint we assert, per caller:
//   anonymous (no cookie)        → 401 (requireAuth throws unauthorized)
//   authenticated-but-forbidden  → 403 (requirePermission throws forbidden)
//   allowed role                 → NOT 401/403 (passed the auth gate; a 200/400/404
//                                   from a missing fixture is fine — we only test the GATE)
//
// 401 vs 403 is intentional: requireAuth runs first and 401s before any permission
// check; requirePermission only runs once authenticated and 403s. So an authed user
// hitting an endpoint they lack permission for gets 403, never 401.
//
// ── HOW TO ADD A ROW ───────────────────────────────────────────────────────────
// Add an entry to MATRIX with:
//   name     — human label for the test output
//   method   — HTTP verb
//   path     — concrete path (use a fabricated UUID for :id params; the gate runs
//              before the row is looked up, so a non-existent id still exercises auth)
//   allow    — roles that should PASS the gate
//   body     — optional request body (only needed if validation runs before the gate;
//              normally the guard is middleware, so body is irrelevant — leave undefined)
// "deny" is derived: every role in ROLES not in `allow`. Anonymous is always tested.
// ─────────────────────────────────────────────────────────────────────────────

type Role = "admin" | "checkin_staff" | "student";
const ROLES: Role[] = ["admin", "checkin_staff", "student"];

// A syntactically-valid UUID that will never exist — exercises the guard, not the row.
const NOPE = "00000000-0000-0000-0000-000000000000";

type Row = {
  name: string;
  method: string;
  path: string;
  allow: Role[];
  body?: unknown;
};

// Representative endpoint per distinct guard across all modules.
const MATRIX: Row[] = [
  // ── User management — admin only (canManageUsers) ──
  { name: "list users", method: "GET", path: "/admin/users", allow: ["admin"] },
  { name: "create user", method: "POST", path: "/admin/users", allow: ["admin"], body: {} },
  { name: "get user", method: "GET", path: `/admin/users/${NOPE}`, allow: ["admin"] },
  { name: "disable user", method: "POST", path: `/admin/users/${NOPE}/disable`, allow: ["admin"], body: {} },
  { name: "reset password (canResetPassword)", method: "POST", path: `/admin/users/${NOPE}/reset-password`, allow: ["admin"], body: {} },

  // ── Event management — admin only (canManageEvents) ──
  { name: "admin list events", method: "GET", path: "/admin/events", allow: ["admin"] },
  { name: "create event", method: "POST", path: "/admin/events", allow: ["admin"], body: {} },
  { name: "edit event", method: "PATCH", path: `/admin/events/${NOPE}`, allow: ["admin"], body: {} },
  { name: "change event status", method: "POST", path: `/admin/events/${NOPE}/status`, allow: ["admin"], body: {} },

  // ── Form builder — admin only (canManageEvents) ──
  { name: "get event form (admin)", method: "GET", path: `/admin/events/${NOPE}/form`, allow: ["admin"] },
  { name: "edit event form", method: "PATCH", path: `/admin/events/${NOPE}/form`, allow: ["admin"], body: {} },

  // ── Check-in — staff OR admin (canScanCheckin / canManualCheckin) ──
  { name: "staff event list", method: "GET", path: "/staff/events", allow: ["admin", "checkin_staff"] },
  { name: "checkin dashboard", method: "GET", path: `/staff/events/${NOPE}/checkin`, allow: ["admin", "checkin_staff"] },
  { name: "scan qr token", method: "POST", path: `/events/${NOPE}/checkins/scan`, allow: ["admin", "checkin_staff"], body: {} },

  // ── Registration admin views — admin only (canManageEvents) ──
  { name: "admin list registrations", method: "GET", path: `/admin/events/${NOPE}/registrations`, allow: ["admin"] },
  { name: "admin force-register", method: "POST", path: `/admin/events/${NOPE}/registrations`, allow: ["admin"], body: {} },

  // ── Audit logs — admin only (canViewAuditLogs) ──
  { name: "list audit logs", method: "GET", path: "/admin/audit-logs", allow: ["admin"] },
  { name: "registration audit logs", method: "GET", path: `/admin/registrations/${NOPE}/audit-logs`, allow: ["admin"] },

  // ── Exports — admin only (canExportRegistrations) ──
  { name: "export registrations summary", method: "GET", path: `/admin/events/${NOPE}/export/registrations-summary`, allow: ["admin"] },

  // ── Imports — admin only (canManageUsers) ──
  { name: "import users preview", method: "POST", path: "/admin/imports/users/preview", allow: ["admin"], body: {} },
  { name: "import result", method: "GET", path: `/admin/imports/${NOPE}/result`, allow: ["admin"] },

  // ── Authenticated-any (requireAuth, no role gate) — every logged-in role allowed ──
  { name: "my registrations", method: "GET", path: "/me/registrations", allow: ROLES },
  { name: "own profile (auth/me)", method: "GET", path: "/auth/me", allow: ROLES },
  { name: "self-register for event", method: "POST", path: `/events/${NOPE}/register`, allow: ROLES, body: {} },
  { name: "cancel own registration", method: "POST", path: `/registrations/${NOPE}/cancel`, allow: ROLES, body: {} },
];

describe("permissions matrix", () => {
  beforeEach(resetDb);

  // Anonymous: every guarded endpoint must reject with 401 (unauthenticated), never 403.
  describe("anonymous (no cookie)", () => {
    it.each(MATRIX)("$method $path → 401 [$name]", async (row) => {
      const res = await request(row.path, { method: row.method, body: row.body });
      expect(res.status).toBe(401);
    });
  });

  // Authenticated-but-forbidden: each role NOT in `allow` must get 403 (passed auth, failed perm).
  describe("forbidden roles → 403", () => {
    const denyCases = MATRIX.flatMap((row) =>
      ROLES.filter((r) => !row.allow.includes(r)).map((role) => ({ row, role })),
    );

    it.each(denyCases)("$role forbidden on $row.method $row.path [$row.name]", async ({ row, role }) => {
      const { cookie } = await loginAs(role);
      const res = await request(row.path, { method: row.method, body: row.body, cookie });
      expect(res.status).toBe(403);
    });
  });

  // Allowed roles: must clear the auth gate (not 401/403). A 400/404 past the gate is acceptable.
  describe("allowed roles → not 401/403", () => {
    const allowCases = MATRIX.flatMap((row) => row.allow.map((role) => ({ row, role })));

    it.each(allowCases)("$role allowed on $row.method $row.path [$row.name]", async ({ row, role }) => {
      const { cookie } = await loginAs(role);
      const res = await request(row.path, { method: row.method, body: row.body, cookie });
      expect([401, 403]).not.toContain(res.status);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File download authorization (canViewUploadedFile) — needs a REAL file row because
// the handler 404s on a missing id BEFORE the permission check. Rule under test:
//   admin       → any file (allow)
//   student     → own file only (allow own / 403 other's)
//   staff       → no files at all (403, even though staff is "trusted" elsewhere)
//   anonymous   → 401
// This is the one guard where the role split lives in the handler, not middleware.
// ─────────────────────────────────────────────────────────────────────────────
describe("file download authorization", () => {
  beforeEach(resetDb);

  // Seed a registration + a form version + an uploaded file owned by the registration's student.
  async function seedFileFor(ownerStudentId: string) {
    const event = await makeEvent();
    const owner = await seedUser({ role: "student" });
    const reg = await makeRegistration({ event, user: owner });
    const [fv] = await db
      .insert(eventFormVersions)
      .values({
        eventId: event.id,
        versionNumber: 1,
        schemaJson: { fields: [] },
        createdByAdminId: event.createdByAdminId,
      })
      .returning();
    const [file] = await db
      .insert(uploadedFiles)
      .values({
        ownerUserId: ownerStudentId,
        eventId: event.id,
        registrationId: reg.id,
        formVersionId: fv!.id,
        formFieldKey: "id_card",
        originalFilename: "id.pdf",
        storedObjectKey: `test/${reg.id}/id.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 123,
        checksumSha256: "deadbeef",
      })
      .returning();
    return file!;
  }

  it("anonymous → 401", async () => {
    const owner = await seedUser({ role: "student" });
    const file = await seedFileFor(owner.id);
    const res = await request(`/files/${file.id}/download`, {});
    expect(res.status).toBe(401);
  });

  it("owner student → not forbidden (passes authz)", async () => {
    const owner = await seedUser({ role: "student" });
    const cookie = await login(owner.studentId as string, owner.password);
    const file = await seedFileFor(owner.id);
    const res = await request(`/files/${file.id}/download`, { cookie });
    // Owner is authorized; storage stream may 500 on missing blob, but never 401/403.
    expect([401, 403]).not.toContain(res.status);
  });

  it("other student → 403", async () => {
    const owner = await seedUser({ role: "student" });
    const file = await seedFileFor(owner.id);
    const { cookie } = await loginAs("student"); // a different student
    const res = await request(`/files/${file.id}/download`, { cookie });
    expect(res.status).toBe(403);
  });

  it("checkin_staff → 403 (staff get no file access)", async () => {
    const owner = await seedUser({ role: "student" });
    const file = await seedFileFor(owner.id);
    const { cookie } = await loginAs("checkin_staff");
    const res = await request(`/files/${file.id}/download`, { cookie });
    expect(res.status).toBe(403);
  });

  it("admin → not forbidden (passes authz on any file)", async () => {
    const owner = await seedUser({ role: "student" });
    const file = await seedFileFor(owner.id);
    const { cookie } = await loginAs("admin");
    const res = await request(`/files/${file.id}/download`, { cookie });
    expect([401, 403]).not.toContain(res.status);
  });
});
