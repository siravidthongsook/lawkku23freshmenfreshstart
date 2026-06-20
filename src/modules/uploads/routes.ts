import { Hono } from "hono";
import { stream } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { and, eq, isNull } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { uploadedFiles } from "../../db/schema/files";
import { registrations } from "../../db/schema/registrations";
import { events } from "../../db/schema/events";
import { eventFormVersions } from "../../db/schema/forms";
import { requireAuth, requestMeta } from "../../lib/auth-middleware";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { canViewUploadedFile } from "../../lib/permissions";
import { sha256Hex } from "../../lib/crypto";
import { storage, buildObjectKey } from "../../lib/storage";
import { writeAudit } from "../../lib/audit";
import { formSchema, isFileField } from "../../lib/form-schema";
import { isWithinWindow } from "../../lib/time";
import { bytesMatchDeclaredType } from "../../lib/file-type";

const router = new Hono<{ Variables: AppVariables }>();

// Allow-list only — PDF/JPG/PNG. Map MIME ↔ extension; reject anything else (exec/script/archive/macro).
const ALLOWED: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
};
const MAX_BYTES = 5 * 1024 * 1024; // 5MB default
// bodyLimit cap sits slightly above MAX_BYTES so a max-size file + multipart framing still passes.
// It bounds RAM by rejecting oversized bodies DURING read, before parseBody/arrayBuffer fully buffer them.
const UPLOAD_BODY_LIMIT = MAX_BYTES + 64 * 1024; // +64KB multipart overhead margin

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

// POST /registrations/:registrationId/files — multipart upload (owner student or admin).
// bodyLimit first: caps RAM by killing oversized bodies during read, before parseBody/arrayBuffer buffer them.
router.post(
  "/registrations/:registrationId/files",
  bodyLimit({
    maxSize: UPLOAD_BODY_LIMIT,
    // Match the post-buffer check's error code (file_too_large); 413 for the early read-time reject.
    onError: (c) =>
      c.json({ error: "file_too_large", message: "File exceeds 5MB limit" }, 413),
  }),
  requireAuth,
  async (c) => {
  const user = c.get("user");
  const registrationId = c.req.param("registrationId");
  const meta = requestMeta(c);

  const [reg] = await db
    .select()
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!reg) throw notFound("Registration not found");

  // Authorize: admin always; otherwise must own the registration (student).
  // canViewUploadedFile encodes student=own / admin=all / staff=none — reuse via ownerUserId semantics.
  const canUpload = canViewUploadedFile(user, { ownerUserId: reg.userId });
  if (!canUpload) throw forbidden("Cannot upload to this registration");

  const body = await c.req.parseBody();
  const fieldKey = typeof body.form_field_key === "string" ? body.form_field_key : "";
  const file = body.file;
  if (!fieldKey) throw badRequest("missing_field_key", "form_field_key is required");
  if (!(file instanceof File)) throw badRequest("missing_file", "file is required");

  const isAdmin = user.role === "admin";

  // Gate students (admins upload as an override, window-exempt).
  // Initial upload happens during the registration window; later replacement needs the edit window.
  if (!isAdmin) {
    if (reg.status === "checked_in")
      throw badRequest("already_checked_in", "Cannot upload after check-in");
    if (reg.status === "cancelled")
      throw badRequest("cancelled", "Cannot upload to a cancelled registration");

    const [event] = await db.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
    if (!event) throw notFound("Event not found");
    const now = new Date();
    const regWindowOpen =
      event.status === "published" &&
      isWithinWindow(now, event.registrationOpenAt, event.registrationCloseAt);
    const editWindowOpen =
      event.allowStudentEditRegistration &&
      isWithinWindow(now, null, event.editRegistrationCloseAt);
    if (!regWindowOpen && !editWindowOpen)
      throw badRequest("upload_window_closed", "Registration/edit window is closed");
  }

  // The field must exist in the registration's own form version AND be a file_upload field.
  if (!reg.formVersionId) throw badRequest("no_form_version", "Registration has no form version");
  const [version] = await db
    .select()
    .from(eventFormVersions)
    .where(eq(eventFormVersions.id, reg.formVersionId))
    .limit(1);
  if (!version) throw notFound("Form version not found");
  const parsed = formSchema.safeParse(version.schemaJson);
  const field = parsed.success ? parsed.data.fields.find((f) => f.key === fieldKey) : undefined;
  if (!field || !isFileField(field))
    throw badRequest("invalid_field", "Field is not a file_upload field on this form");

  const filename = file.name || "upload";
  const ext = extOf(filename);
  const mime = file.type || "";

  // Validate MIME against allow-list AND ensure extension matches that MIME.
  const allowedExts = ALLOWED[mime];
  if (!allowedExts || !allowedExts.includes(ext)) {
    throw badRequest("unsupported_file_type", "Only PDF, JPG, PNG are allowed");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength === 0) throw badRequest("empty_file", "File is empty");
  if (buffer.byteLength > MAX_BYTES) {
    throw badRequest("file_too_large", "File exceeds 5MB limit");
  }

  // Magic-byte verification: the client Content-Type/extension above is just a cheap pre-filter.
  // Reject if the actual bytes don't match the declared (allow-listed) type — no spoofed labels.
  if (!bytesMatchDeclaredType(buffer, mime)) {
    throw badRequest("invalid_file_content", "File content does not match its declared type");
  }

  const checksum = sha256Hex(buffer);
  const objectKey = buildObjectKey(registrationId, fieldKey, filename);
  await storage.put(objectKey, buffer);

  // reason for soft-delete differs by actor — admin replacing vs the owner replacing.
  const replaceReason = user.role === "admin" ? "replaced_by_admin" : "replaced_by_user";

  const inserted = await db.transaction(async (tx) => {
    // Lock the registration row so two concurrent uploads for the same field serialize:
    // the second waits, sees the first's soft-delete, and won't create a 2nd live row.
    // Backstop is the partial unique index (one live row per registration+field).
    await tx.select({ id: registrations.id }).from(registrations).where(eq(registrations.id, registrationId)).for("update");

    // Soft-delete any existing live file for the same (registration, field) — keep history.
    await tx
      .update(uploadedFiles)
      .set({ deletedAt: new Date(), deletedReason: replaceReason })
      .where(
        and(
          eq(uploadedFiles.registrationId, registrationId),
          eq(uploadedFiles.formFieldKey, fieldKey),
          isNull(uploadedFiles.deletedAt),
        ),
      );

    const [row] = await tx
      .insert(uploadedFiles)
      .values({
        ownerUserId: reg.userId,
        eventId: reg.eventId,
        registrationId: reg.id,
        formVersionId: reg.formVersionId!, // file_upload only valid once reg has a form version
        formFieldKey: fieldKey,
        originalFilename: filename,
        storedObjectKey: objectKey,
        mimeType: mime,
        fileSizeBytes: buffer.byteLength,
        checksumSha256: checksum,
      })
      .returning();
    if (!row) throw badRequest("upload_failed", "Could not store file metadata");

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "uploaded_file_added",
        entityType: "uploaded_file",
        entityId: row.id,
        eventId: reg.eventId,
        registrationId: reg.id,
        targetUserId: reg.userId,
        metadata: { form_field_key: fieldKey, file_size_bytes: buffer.byteLength, mime_type: mime },
        ...meta,
      },
      tx,
    );
    return row;
  });

  return c.json(
    {
      id: inserted.id,
      original_filename: inserted.originalFilename,
      mime_type: inserted.mimeType,
      file_size_bytes: inserted.fileSizeBytes,
      checksum_sha256: inserted.checksumSha256,
      form_field_key: inserted.formFieldKey,
      uploaded_at: inserted.uploadedAt.toISOString(),
    },
    201,
  );
  },
);

// GET /files/:fileId/download — authorize (student=own, admin=all, staff=none), stream from private storage.
router.get("/files/:fileId/download", requireAuth, async (c) => {
  const user = c.get("user");
  const fileId = c.req.param("fileId");
  const meta = requestMeta(c);

  const [file] = await db
    .select()
    .from(uploadedFiles)
    .where(eq(uploadedFiles.id, fileId))
    .limit(1);
  // Treat soft-deleted as not found (no download of replaced files).
  if (!file || file.deletedAt) throw notFound("File not found");

  if (!canViewUploadedFile(user, file)) throw forbidden("Cannot access this file");

  // Admin downloads of others' files are sensitive — audit them.
  if (user.role === "admin" && file.ownerUserId !== user.id) {
    await writeAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: "uploaded_file_downloaded",
      entityType: "uploaded_file",
      entityId: file.id,
      eventId: file.eventId,
      registrationId: file.registrationId,
      targetUserId: file.ownerUserId,
      metadata: { original_filename: file.originalFilename },
      ...meta,
    });
  }

  const nodeStream = storage.getStream(file.storedObjectKey);
  // Serve only an allow-listed Content-Type. New uploads are magic-byte verified, but map
  // through the allow-list anyway so legacy/pre-fix rows can't echo an attacker-chosen type.
  const safeContentType = ALLOWED[file.mimeType] ? file.mimeType : "application/octet-stream";
  c.header("Content-Type", safeContentType);
  c.header(
    "Content-Disposition",
    `attachment; filename="${file.originalFilename.replace(/"/g, "")}"`,
  );
  // Bridge Node ReadStream → Hono web stream.
  return stream(c, async (s) => {
    for await (const chunk of nodeStream) {
      await s.write(chunk as Uint8Array);
    }
  });
});

export default router;
