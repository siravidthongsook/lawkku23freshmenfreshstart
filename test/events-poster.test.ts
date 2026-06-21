import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { events as eventsTable } from "../src/db/schema/events";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";

// ---------------------------------------------------------------------------
// Event poster endpoints (previously untested):
//   POST   /admin/events/:eventId/poster  — multipart upload (admin, JPG/PNG only)
//   DELETE /admin/events/:eventId/poster  — clear poster
//   GET    /events/:publicId/poster       — public stream from private storage
//
// Mirrors the upload patterns in uploads.test.ts (magic-byte/allow-list/size),
// but posters are image-only (no PDF) and keyed off the event row's publicId.
// ---------------------------------------------------------------------------

// --- In-memory buffers with correct magic bytes (tiny, well under the 5MB cap). ---
function pngBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("stub-png-data")]);
}
function jpgBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("stub-jpg-data")]);
}

// Build the multipart body for the poster endpoint.
function posterForm(buf: Buffer, filename: string, mime: string): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(buf)], filename, { type: mime }));
  return fd;
}

function postPoster(eventId: string, cookie: string | undefined, fd: FormData) {
  return request(`/admin/events/${eventId}/poster`, { method: "POST", cookie, body: fd });
}
function deletePoster(eventId: string, cookie: string | undefined) {
  return request(`/admin/events/${eventId}/poster`, { method: "DELETE", cookie });
}
function getPoster(publicId: string) {
  return request(`/events/${publicId}/poster`);
}

// Re-read the event row to grab the freshly-set posterObjectKey (for storage cleanup + serve).
async function eventRow(id: string) {
  const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  return row;
}

// Track stored object keys so we can clean STORAGE_DIR afterward.
const storedKeys = new Set<string>();
afterAll(async () => {
  const base = resolve(env.STORAGE_DIR);
  for (const key of storedKeys) {
    const full = resolve(base, key);
    if (full.startsWith(base + "/") && existsSync(full)) {
      await rm(full, { force: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Upload happy path + public serve + cache-bust URL.
// ---------------------------------------------------------------------------
describe("poster: upload + public serve", () => {
  it("uploads a valid PNG → 201, stored privately, posterImageUrl carries a ?v= cache-bust", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });

    const res = await postPoster(event.id, admin.cookie, posterForm(pngBuffer(), "poster.png", "image/png"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { posterObjectKey: string; posterImageUrl: string } };

    // Stored under STORAGE_DIR with an opaque server-built key (never a public path).
    const key = body.event.posterObjectKey;
    expect(typeof key).toBe("string");
    expect(key.startsWith("/")).toBe(false);
    storedKeys.add(key);
    const base = resolve(env.STORAGE_DIR);
    const full = resolve(base, key);
    expect(full.startsWith(base + "/")).toBe(true);
    expect(existsSync(full)).toBe(true);

    // posterImageUrl points at the stable publicId serve endpoint + a ?v= cache-bust token.
    expect(body.event.posterImageUrl).toMatch(
      new RegExp(`^/events/${event.publicId}/poster\\?v=\\d+$`),
    );
  });

  it("uploads a valid JPG → 201 and public serve returns the exact bytes", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });

    const up = await postPoster(event.id, admin.cookie, posterForm(jpgBuffer(), "poster.jpg", "image/jpeg"));
    expect(up.status).toBe(201);
    storedKeys.add(((await up.json()) as { event: { posterObjectKey: string } }).event.posterObjectKey);

    // Public serve keyed by publicId returns the stored image bytes + image content-type + immutable cache.
    const res = await getPoster(event.publicId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(jpgBuffer())).toBe(true);
  });

  it("public serve sets image/png content-type for a .png-keyed poster", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });
    const up = await postPoster(event.id, admin.cookie, posterForm(pngBuffer(), "card.png", "image/png"));
    expect(up.status).toBe(201);
    storedKeys.add(((await up.json()) as { event: { posterObjectKey: string } }).event.posterObjectKey);

    const res = await getPoster(event.publicId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// 2. Allow-list + size + magic-byte rejections (image-only; no PDF for posters).
// ---------------------------------------------------------------------------
describe("poster: upload rejections", () => {
  it("rejects a GIF (image but not allow-listed) → 400 unsupported_file_type", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await postPoster(event.id, admin.cookie, posterForm(Buffer.from("GIF89a"), "x.gif", "image/gif"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_file_type");
  });

  it("rejects a .txt → 400 unsupported_file_type", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await postPoster(event.id, admin.cookie, posterForm(Buffer.from("hello"), "note.txt", "text/plain"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_file_type");
  });

  it("rejects a PDF (allowed for doc uploads but NOT for posters) → 400 unsupported_file_type", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const res = await postPoster(event.id, admin.cookie, posterForm(pdf, "doc.pdf", "application/pdf"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_file_type");
  });

  it("rejects an empty (0-byte) image → 400 empty_file", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(0)], "empty.png", { type: "image/png" }));
    const res = await postPoster(event.id, admin.cookie, fd);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("empty_file");
  });

  it("rejects a file over the 5MB cap → 413 file_too_large (bodyLimit early reject)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    // PNG header + padding past the bodyLimit (5MB + 64KB margin) so the read-time bodyLimit trips first.
    const big = Buffer.concat([pngBuffer(), Buffer.alloc(5 * 1024 * 1024 + 128 * 1024, 0x41)]);
    const res = await postPoster(event.id, admin.cookie, posterForm(big, "big.png", "image/png"));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("file_too_large");
  });

  it("magic-byte: spoofed image/png + .png ext but non-image bytes → 400 invalid_file_content", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const spoof = Buffer.from("<script>alert(1)</script> not really a png");
    const res = await postPoster(event.id, admin.cookie, posterForm(spoof, "evil.png", "image/png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_file_content");
  });

  it("upload to an unknown event → 404", async () => {
    const admin = await loginAs("admin");
    const res = await postPoster(
      "00000000-0000-0000-0000-000000000000",
      admin.cookie,
      posterForm(pngBuffer(), "x.png", "image/png"),
    );
    expect(res.status).toBe(404);
  });

  it("non-admin (student) CANNOT upload a poster → 403", async () => {
    const event = await makeEvent({ status: "published" });
    const student = await loginAs("student");
    const res = await postPoster(event.id, student.cookie, posterForm(pngBuffer(), "x.png", "image/png"));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. Public serve visibility + delete clears the poster.
// ---------------------------------------------------------------------------
describe("poster: serve visibility + delete", () => {
  it("public serve of a DRAFT event's poster → 404 (draft is not public)", async () => {
    const admin = await loginAs("admin");
    // Upload while published so a poster object exists...
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });
    const up = await postPoster(event.id, admin.cookie, posterForm(pngBuffer(), "p.png", "image/png"));
    expect(up.status).toBe(201);
    storedKeys.add(((await up.json()) as { event: { posterObjectKey: string } }).event.posterObjectKey);

    // ...then move the event back to draft → public poster serve must 404.
    await db.update(eventsTable).set({ status: "draft" }).where(eq(eventsTable.id, event.id));
    const res = await getPoster(event.publicId);
    expect(res.status).toBe(404);
  });

  it("public serve when the event has no poster → 404", async () => {
    const event = await makeEvent({ status: "published" }); // never uploaded a poster
    const res = await getPoster(event.publicId);
    expect(res.status).toBe(404);
  });

  it("delete poster → row cleared, then public serve → 404", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });
    const up = await postPoster(event.id, admin.cookie, posterForm(pngBuffer(), "p.png", "image/png"));
    expect(up.status).toBe(201);
    storedKeys.add(((await up.json()) as { event: { posterObjectKey: string } }).event.posterObjectKey);

    // Serves while present.
    expect((await getPoster(event.publicId)).status).toBe(200);

    const del = await deletePoster(event.id, admin.cookie);
    expect(del.status).toBe(200);

    // Row's poster fields cleared (no hard delete of the event itself).
    const row = await eventRow(event.id);
    expect(row?.posterObjectKey).toBeNull();
    expect(row?.posterImageUrl).toBeNull();

    // Public serve now 404s (no poster key).
    expect((await getPoster(event.publicId)).status).toBe(404);
  });

  it("non-admin (student) CANNOT delete a poster → 403", async () => {
    const event = await makeEvent({ status: "published" });
    const student = await loginAs("student");
    const res = await deletePoster(event.id, student.cookie);
    expect(res.status).toBe(403);
  });
});
