import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { uploadedFiles } from "../src/db/schema/files";
import { events as eventsTable } from "../src/db/schema/events";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";
import type { User } from "../src/db/schema/users";
import type { FormSchema } from "../src/lib/form-schema";

// ---------------------------------------------------------------------------
// Local helpers — the harness has no form/upload factory. Uploads require a
// registration whose form version contains a `file_upload` field matching the
// posted form_field_key, so each test must wire that chain manually.
// ---------------------------------------------------------------------------

const FILE_FIELD = "doc"; // the file_upload field key used across tests

// Form version with one required file_upload field. Returns the version id.
async function makeFileFormVersion(event: Event): Promise<string> {
  const schema: FormSchema = {
    fields: [{ key: FILE_FIELD, type: "file_upload", label: "Document", required: true, sort: 0 }],
  };
  const [row] = await db
    .insert(eventFormVersions)
    .values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: schema,
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    })
    .returning();
  if (!row) throw new Error("makeFileFormVersion: insert returned no row");
  return row.id;
}

// Registered student + event + file-field form version, all linked. The default
// makeEvent() is published with null reg window → isWithinWindow() is open, so a
// student upload is allowed without any window juggling.
async function makeUploadContext(opts?: { studentUser?: User; status?: "registered" | "checked_in" | "cancelled" }) {
  const event = await makeEvent();
  const versionId = await makeFileFormVersion(event);
  const student = opts?.studentUser ?? (await seedUser({ role: "student" }));
  const status = opts?.status ?? "registered";
  const [reg] = await db
    .insert(registrations)
    .values({
      eventId: event.id,
      userId: student.id,
      status,
      formVersionId: versionId,
      registeredAt: status === "cancelled" ? null : new Date(),
    })
    .returning();
  if (!reg) throw new Error("makeUploadContext: registration insert failed");
  return { event, versionId, student, reg };
}

// --- In-memory file buffers with correct magic bytes. ---
// Minimal but real-enough headers; the size stays tiny (well under the 5MB cap).
function pngBuffer(): Buffer {
  // PNG signature + a stub of bytes.
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("stub-png-data")]);
}
function jpgBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("stub-jpg-data")]);
}
function pdfBuffer(): Buffer {
  return Buffer.from("%PDF-1.4\n%stub-pdf-data\n%%EOF\n");
}

// Build a FormData body for the upload endpoint. mime defaults to a sane value.
function uploadForm(buf: Buffer, filename: string, mime: string, fieldKey: string = FILE_FIELD): FormData {
  const fd = new FormData();
  fd.set("form_field_key", fieldKey);
  fd.set("file", new File([new Uint8Array(buf)], filename, { type: mime }));
  return fd;
}

function postUpload(regId: string, cookie: string | undefined, fd: FormData) {
  return request(`/registrations/${regId}/files`, { method: "POST", cookie, body: fd });
}

function downloadFile(fileId: string, cookie?: string) {
  return request(`/files/${fileId}/download`, { method: "GET", cookie });
}

// Track stored object keys so we can clean STORAGE_DIR afterward.
const storedKeys = new Set<string>();
async function liveFileRow(regId: string) {
  const [row] = await db
    .select()
    .from(uploadedFiles)
    .where(and(eq(uploadedFiles.registrationId, regId), isNull(uploadedFiles.deletedAt)))
    .limit(1);
  if (row) storedKeys.add(row.storedObjectKey);
  return row;
}

afterAll(async () => {
  // Best-effort cleanup of files this suite wrote under STORAGE_DIR.
  const base = resolve(env.STORAGE_DIR);
  for (const key of storedKeys) {
    const full = resolve(base, key);
    if (full.startsWith(base + "/") && existsSync(full)) {
      await rm(full, { force: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Allow-list — PDF / JPG / PNG accepted; everything else rejected.
// ---------------------------------------------------------------------------
describe("uploads: allow-list (PDF/JPG/PNG)", () => {
  it("accepts a PNG → 201 + file row", async () => {
    const { reg } = await makeUploadContext();
    // Upload as admin (window-exempt) to validate the happy path independent of ownership.
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pngBuffer(), "scan.png", "image/png"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mime_type).toBe("image/png");
    expect(body.original_filename).toBe("scan.png");
    expect(typeof body.id).toBe("string");
    expect(typeof body.checksum_sha256).toBe("string");
    const row = await liveFileRow(reg.id);
    expect(row).toBeTruthy();
    expect(row!.mimeType).toBe("image/png");
  });

  it("accepts a JPG (.jpg) → 201", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(jpgBuffer(), "photo.jpg", "image/jpeg"));
    expect(res.status).toBe(201);
    await liveFileRow(reg.id);
  });

  it("accepts a JPEG (.jpeg) variant → 201", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(jpgBuffer(), "photo.jpeg", "image/jpeg"));
    expect(res.status).toBe(201);
    await liveFileRow(reg.id);
  });

  it("accepts a PDF → 201", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pdfBuffer(), "form.pdf", "application/pdf"));
    expect(res.status).toBe(201);
    await liveFileRow(reg.id);
  });

  it("rejects a disallowed MIME (.txt) → 400 unsupported_file_type", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(Buffer.from("hello"), "note.txt", "text/plain"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unsupported_file_type");
    expect(typeof body.message).toBe("string");
  });

  it("rejects an SVG (image but not allow-listed) → 400", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(Buffer.from("<svg/>"), "x.svg", "image/svg+xml"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_file_type");
  });

  it("rejects an executable (.exe) → 400", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(Buffer.from("MZ"), "x.exe", "application/octet-stream"));
    expect(res.status).toBe(400);
  });

  it("rejects extension/MIME mismatch — allowed MIME but wrong ext (.txt declared image/png) → 400", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    // MIME is allow-listed (image/png) but extension (.txt) is not in its ext list → must reject.
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pngBuffer(), "evil.txt", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_file_type");
  });

  it("rejects allowed ext but disallowed MIME (.png declared text/plain) → 400", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pngBuffer(), "real.png", "text/plain"));
    expect(res.status).toBe(400);
  });

  it("rejects upload missing the file part → 400 missing_file", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const fd = new FormData();
    fd.set("form_field_key", FILE_FIELD);
    const res = await postUpload(reg.id, admin.cookie, fd);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("missing_file");
  });

  it("rejects upload missing form_field_key → 400 missing_field_key", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(pngBuffer())], "a.png", { type: "image/png" }));
    const res = await postUpload(reg.id, admin.cookie, fd);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("missing_field_key");
  });

  it("rejects a field key that is not a file_upload field on the form → 400 invalid_field", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pngBuffer(), "a.png", "image/png", "not_a_real_field"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_field");
  });
});

// ---------------------------------------------------------------------------
// 2. Private storage — stored under STORAGE_DIR, no public path/URL.
// ---------------------------------------------------------------------------
describe("uploads: private storage", () => {
  it("stores the file under STORAGE_DIR with an opaque namespaced key, never web-public", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(pngBuffer(), "p.png", "image/png"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // Response never leaks a storage path or public URL.
    expect(JSON.stringify(body)).not.toContain(".storage");
    expect(body).not.toHaveProperty("stored_object_key");
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("path");

    const row = await liveFileRow(reg.id);
    expect(row).toBeTruthy();
    // Key is namespaced under the registration id, not an absolute/public path.
    expect(row!.storedObjectKey.startsWith(reg.id + "/")).toBe(true);
    expect(row!.storedObjectKey.startsWith("/")).toBe(false);
    // The actual byte file lives inside STORAGE_DIR.
    const base = resolve(env.STORAGE_DIR);
    const full = resolve(base, row!.storedObjectKey);
    expect(full.startsWith(base + "/")).toBe(true);
    expect(existsSync(full)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Authorized download matrix + real bytes/headers.
// ---------------------------------------------------------------------------
describe("uploads: authorized download", () => {
  // Upload as admin into a known student's registration, return the file id + owner.
  async function seedDownloadable(buf: Buffer = pngBuffer(), filename = "owned.png", mime = "image/png") {
    const ctx = await makeUploadContext();
    const admin = await loginAs("admin");
    const res = await postUpload(ctx.reg.id, admin.cookie, uploadForm(buf, filename, mime));
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);
    return { ...ctx, fileId, buf, filename, mime };
  }

  it("owner (uploading student) can download own file → 200 + bytes + headers", async () => {
    // Create the student via loginAs so we have a usable cookie, then build context for that user.
    const owner = await loginAs("student");
    const ctx = await makeUploadContext({ studentUser: owner.user });
    const admin = await loginAs("admin");
    const up = await postUpload(ctx.reg.id, admin.cookie, uploadForm(pdfBuffer(), "mine.pdf", "application/pdf"));
    expect(up.status).toBe(201);
    const fileId = ((await up.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);

    const res = await downloadFile(fileId, owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="mine.pdf"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(pdfBuffer())).toBe(true);
  });

  it("admin can download any file → 200 + bytes", async () => {
    const d = await seedDownloadable();
    const admin = await loginAs("admin");
    const res = await downloadFile(d.fileId, admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(pngBuffer())).toBe(true);
  });

  it("another student CANNOT download someone else's file → 403", async () => {
    const d = await seedDownloadable();
    const stranger = await loginAs("student");
    const res = await downloadFile(d.fileId, stranger.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("forbidden");
  });

  it("checkin_staff CANNOT download files → 403", async () => {
    const d = await seedDownloadable();
    const staff = await loginAs("checkin_staff");
    const res = await downloadFile(d.fileId, staff.cookie);
    expect(res.status).toBe(403);
  });

  it("anonymous CANNOT download → 401", async () => {
    const d = await seedDownloadable();
    const res = await downloadFile(d.fileId, undefined);
    expect(res.status).toBe(401);
  });

  it("download of a non-existent file id → 404", async () => {
    const admin = await loginAs("admin");
    const res = await downloadFile("00000000-0000-0000-0000-000000000000", admin.cookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. Path-traversal guard (storage layer). The object key is server-built and
// the route only takes a UUID file id, so traversal can't be injected via the
// HTTP boundary. We assert the storage guard directly + that crafted keys can't
// escape STORAGE_DIR, and that a DB row with a malicious key 404s/errors safely.
// ---------------------------------------------------------------------------
describe("uploads: path-traversal guard", () => {
  it("storage rejects keys that escape STORAGE_DIR (../, absolute)", async () => {
    const { storage } = await import("../src/lib/storage");
    await expect(storage.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(/invalid storage key/);
    await expect(storage.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/invalid storage key/);
    await expect(storage.put("a/../../escape.txt", Buffer.from("x"))).rejects.toThrow(/invalid storage key/);
    // getStream resolves the same guard before opening.
    expect(() => storage.getStream("../../etc/passwd")).toThrow(/invalid storage key/);
  });

  it("download endpoint id param: a traversal/non-UUID id never reads the filesystem (DB UUID cast rejects it first)", async () => {
    const admin = await loginAs("admin");
    // The id column is uuid; a '../' style id fails the uuid cast → error, never a path read.
    // NOTE: this surfaces as 500 (internal_error) rather than a clean 404 — see report.
    const res = await downloadFile(encodeURIComponent("../../etc/passwd"), admin.cookie);
    expect([404, 400, 500]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    // Whatever the status, no file bytes are returned — the response is a JSON error.
    expect(res.headers.get("content-type") ?? "").toContain("json");
  });

  it("buildObjectKey strips path separators from filename + namespaces under registration id", async () => {
    const { buildObjectKey } = await import("../src/lib/storage");
    const key = buildObjectKey("reg-123", "doc", "../../../etc/passwd");
    expect(key.startsWith("reg-123/doc/")).toBe(true);
    // The filename component has all '/' stripped (replaced with '_'), so even though the
    // dots survive, there's no separator → it can't climb out of reg-123/doc/.
    const filenamePart = key.slice("reg-123/doc/".length);
    expect(filenamePart).not.toContain("/");
    expect(key).not.toContain("/etc/");
  });
});

// ---------------------------------------------------------------------------
// 5. Soft-delete / no hard delete — replacing an upload soft-deletes the old row.
// ---------------------------------------------------------------------------
describe("uploads: soft-delete on replace (history kept, no hard delete)", () => {
  it("uploading again to the same (registration, field) soft-deletes the old row and keeps it", async () => {
    const ctx = await makeUploadContext();
    const admin = await loginAs("admin");

    const first = await postUpload(ctx.reg.id, admin.cookie, uploadForm(pngBuffer(), "v1.png", "image/png"));
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);

    const second = await postUpload(ctx.reg.id, admin.cookie, uploadForm(pdfBuffer(), "v2.pdf", "application/pdf"));
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);

    // Old row still exists (no hard delete) but is soft-deleted with a reason.
    const [oldRow] = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, firstId)).limit(1);
    expect(oldRow).toBeTruthy();
    expect(oldRow!.deletedAt).not.toBeNull();
    expect(oldRow!.deletedReason).toBe("replaced_by_admin");

    // New row is live.
    const [newRow] = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, secondId)).limit(1);
    expect(newRow!.deletedAt).toBeNull();

    // Exactly one live row for the (registration, field).
    const live = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.registrationId, ctx.reg.id), isNull(uploadedFiles.deletedAt)));
    expect(live.length).toBe(1);
    expect(live[0]!.id).toBe(secondId);
  });

  it("downloading a soft-deleted (replaced) file → 404", async () => {
    const ctx = await makeUploadContext();
    const admin = await loginAs("admin");
    const first = await postUpload(ctx.reg.id, admin.cookie, uploadForm(pngBuffer(), "old.png", "image/png"));
    const firstId = ((await first.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);
    await postUpload(ctx.reg.id, admin.cookie, uploadForm(pdfBuffer(), "new.pdf", "application/pdf"));
    await liveFileRow(ctx.reg.id);

    const res = await downloadFile(firstId, admin.cookie);
    expect(res.status).toBe(404); // soft-deleted files are not downloadable
  });

  it("a student replacing their own file gets deleted_reason=replaced_by_user", async () => {
    const owner = await loginAs("student");
    const ctx = await makeUploadContext({ studentUser: owner.user });
    const first = await postUpload(ctx.reg.id, owner.cookie, uploadForm(pngBuffer(), "a.png", "image/png"));
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;
    await liveFileRow(ctx.reg.id);
    const second = await postUpload(ctx.reg.id, owner.cookie, uploadForm(pdfBuffer(), "b.pdf", "application/pdf"));
    expect(second.status).toBe(201);
    await liveFileRow(ctx.reg.id);

    const [oldRow] = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, firstId)).limit(1);
    expect(oldRow!.deletedReason).toBe("replaced_by_user");
  });
});

// ---------------------------------------------------------------------------
// 6. Size / corrupt / ownership + window gating edge cases.
// ---------------------------------------------------------------------------
describe("uploads: edge cases", () => {
  it("rejects an empty (0-byte) file → 400 empty_file", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const fd = new FormData();
    fd.set("form_field_key", FILE_FIELD);
    fd.set("file", new File([new Uint8Array(0)], "empty.png", { type: "image/png" }));
    const res = await postUpload(reg.id, admin.cookie, fd);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("empty_file");
  });

  it("rejects a file over the 5MB cap → 400 file_too_large", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    // PNG header + >5MB padding so the type passes but size fails.
    const big = Buffer.concat([pngBuffer(), Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)]);
    const res = await postUpload(reg.id, admin.cookie, uploadForm(big, "big.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("file_too_large");
  });

  it("a student CANNOT upload to a registration they do not own → 403", async () => {
    const ctx = await makeUploadContext(); // owner is some seeded student
    const stranger = await loginAs("student");
    const res = await postUpload(ctx.reg.id, stranger.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(403);
  });

  it("checkin_staff CANNOT upload → 403", async () => {
    const ctx = await makeUploadContext();
    const staff = await loginAs("checkin_staff");
    const res = await postUpload(ctx.reg.id, staff.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(403);
  });

  it("anonymous CANNOT upload → 401", async () => {
    const ctx = await makeUploadContext();
    const res = await postUpload(ctx.reg.id, undefined, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(401);
  });

  it("upload to a non-existent registration → 404", async () => {
    const admin = await loginAs("admin");
    const res = await postUpload(
      "00000000-0000-0000-0000-000000000000",
      admin.cookie,
      uploadForm(pngBuffer(), "x.png", "image/png"),
    );
    expect(res.status).toBe(404);
  });

  it("student CANNOT upload after check-in → 400 already_checked_in", async () => {
    const owner = await loginAs("student");
    const ctx = await makeUploadContext({ studentUser: owner.user, status: "checked_in" });
    const res = await postUpload(ctx.reg.id, owner.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("already_checked_in");
  });

  it("student CANNOT upload to a cancelled registration → 400 cancelled", async () => {
    const owner = await loginAs("student");
    const ctx = await makeUploadContext({ studentUser: owner.user, status: "cancelled" });
    const res = await postUpload(ctx.reg.id, owner.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("cancelled");
  });

  it("admin CAN upload to a checked-in registration (window-exempt override)", async () => {
    const ctx = await makeUploadContext({ status: "checked_in" });
    const admin = await loginAs("admin");
    const res = await postUpload(ctx.reg.id, admin.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(201);
    await liveFileRow(ctx.reg.id);
  });

  it("student CANNOT upload when the registration window is closed → 400 upload_window_closed", async () => {
    const owner = await loginAs("student");
    // Event published but reg window already closed (yesterday), no edit window.
    const event = await makeEvent({
      registrationOpenAt: new Date(Date.now() - 2 * 86400_000),
      registrationCloseAt: new Date(Date.now() - 86400_000),
    });
    const versionId = await makeFileFormVersion(event);
    const [reg] = await db
      .insert(registrations)
      .values({ eventId: event.id, userId: owner.user.id, status: "registered", formVersionId: versionId, registeredAt: new Date() })
      .returning();
    const res = await postUpload(reg!.id, owner.cookie, uploadForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("upload_window_closed");
  });
});

// ---------------------------------------------------------------------------
// SECURITY: magic-byte verification — the allow-list MIME+ext check is only a
// pre-filter; the route also sniffs the actual bytes. A text/script payload
// renamed `x.png` with Content-Type image/png is now REJECTED (invalid_file_content).
// ---------------------------------------------------------------------------
describe("uploads: magic-byte verification (content must match declared type)", () => {
  it("a non-image payload with spoofed image/png type + .png ext is REJECTED → 400 invalid_file_content", async () => {
    const { reg } = await makeUploadContext();
    const admin = await loginAs("admin");
    const spoof = Buffer.from("<script>alert(1)</script> not really a png");
    const res = await postUpload(reg.id, admin.cookie, uploadForm(spoof, "evil.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_file_content");
  });
});
