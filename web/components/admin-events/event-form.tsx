"use client";

// Shared create/edit event form. Used by /admin/events/new (mode="create") and /admin/events/[id]/edit.
// Validates with createEventSchema/updateEventSchema before sending; sends ISO-UTC strings (backend coerces).
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";
import { apiPost, apiPatch, apiPostForm, apiDelete, ApiError } from "@/lib/api";
import {
  createEventSchema,
  updateEventSchema,
  registrationModeEnum,
} from "@/lib/schemas";
import type { EventAdmin } from "@/lib/types";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ImageOff } from "lucide-react";
import { PosterCropDialog } from "./poster-crop-dialog";
import { isoToBangkokInput, bangkokInputToIso } from "./datetime";

type Mode = "create" | "edit";

// Loose initial shape — EventAdmin in edit mode, undefined in create. Backend returns raw row.
type Props = {
  mode: Mode;
  eventId?: string;
  initial?: Partial<EventAdmin> | null;
};

// public_self_register = self-register, but only existing (admin-provisioned + claimed) accounts; no public signup exists.
const REG_MODE_LABEL: Record<string, string> = {
  public_self_register: "เปิดให้ผู้มีบัญชีลงทะเบียนเอง",
  closed: "ปิด",
};

// Local slug format hint — matches backend slugify (letters/numbers/hyphen, lowercase).
// We only validate the user's raw input for obviously-bad chars; backend normalizes on save.
const SLUG_OK = /^[\p{L}\p{N}-]*$/u;

// Drop one key from a record without mutating it.
function omit(obj: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _, ...rest } = obj;
  return rest;
}

export function EventForm({ mode, eventId, initial }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // Per-field validation errors (keyed by field name). Cleared on edit + before each submit.
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Set once the user edits anything → drives the unsaved-changes guard. Cleared on successful save.
  const [dirty, setDirty] = useState(false);
  // Form element ref for scroll-to-first-error.
  const formRef = useRef<HTMLFormElement>(null);

  // Form state. Times kept as Bangkok wall-clock strings for the datetime-local inputs.
  const [title, setTitle] = useState(initial?.title ?? "");
  const [publicSlug, setPublicSlug] = useState(initial?.publicSlug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [registrationMode, setRegistrationMode] = useState(
    initial?.registrationMode ?? "closed",
  );
  const [registrationOpenAt, setRegistrationOpenAt] = useState(
    isoToBangkokInput(initial?.registrationOpenAt),
  );
  const [registrationCloseAt, setRegistrationCloseAt] = useState(
    isoToBangkokInput(initial?.registrationCloseAt),
  );
  const [checkinOpenAt, setCheckinOpenAt] = useState(isoToBangkokInput(initial?.checkinOpenAt));
  const [checkinCloseAt, setCheckinCloseAt] = useState(isoToBangkokInput(initial?.checkinCloseAt));
  const [eventStartAt, setEventStartAt] = useState(isoToBangkokInput(initial?.eventStartAt));
  const [eventEndAt, setEventEndAt] = useState(isoToBangkokInput(initial?.eventEndAt));
  const [capacityEnabled, setCapacityEnabled] = useState(initial?.capacityEnabled ?? false);
  const [capacityLimit, setCapacityLimit] = useState<string>(
    initial?.capacityLimit != null ? String(initial.capacityLimit) : "",
  );
  const [waitlistEnabled, setWaitlistEnabled] = useState(initial?.waitlistEnabled ?? false);
  const [allowStudentCancel, setAllowStudentCancel] = useState(
    initial?.allowStudentCancelRegistration ?? false,
  );
  const [cancelCloseAt, setCancelCloseAt] = useState(
    isoToBangkokInput(initial?.cancelRegistrationCloseAt),
  );
  const [allowStudentEdit, setAllowStudentEdit] = useState(
    initial?.allowStudentEditRegistration ?? false,
  );
  const [editCloseAt, setEditCloseAt] = useState(isoToBangkokInput(initial?.editRegistrationCloseAt));

  // Poster state — DRAFT model: pick → crop → stage locally; only uploaded inside handleSubmit after the event PATCH.
  const posterInputRef = useRef<HTMLInputElement>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(initial?.posterImageUrl ?? null);
  // Crop modal: objectURL of the raw picked file + its mime (preserved on export for the allow-list).
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropMime, setCropMime] = useState<string>("image/jpeg");
  const [cropOpen, setCropOpen] = useState(false);
  // Staged (not-yet-uploaded) cropped poster + its preview objectURL.
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  // In-flight flag for the immediate poster-delete call.
  const [removingPoster, setRemovingPoster] = useState(false);

  // Warn before leaving with unsaved edits (tab close / in-app link). See use-unsaved-changes.
  useUnsavedChanges(dirty);

  // Revoke any live objectURLs on unmount (raw crop src + staged preview) to avoid leaks.
  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup-only; refs read at unmount
  }, []);

  // Pick a file → validate → open the crop modal. No upload here (draft model).
  function handlePosterChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side guards mirror the backend allow-list (JPG/PNG, max 5MB).
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast.error("รองรับเฉพาะไฟล์ PNG หรือ JPG เท่านั้น");
      if (posterInputRef.current) posterInputRef.current.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("ขนาดไฟล์ต้องไม่เกิน 5MB");
      if (posterInputRef.current) posterInputRef.current.value = "";
      return;
    }
    // Replace any previous raw src before staging the new one.
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(URL.createObjectURL(file));
    setCropMime(file.type);
    setCropOpen(true);
  }

  // Cancel crop → discard raw src, reset input so the same file can be re-picked.
  function handleCropCancel() {
    setCropOpen(false);
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    if (posterInputRef.current) posterInputRef.current.value = "";
  }

  // Confirm crop → stage the blob + a fresh preview objectURL; mark dirty so Save (and the guard) fire.
  function handleCropConfirm(blob: Blob) {
    setCropOpen(false);
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingBlob(blob);
    setPendingPreviewUrl(URL.createObjectURL(blob));
    setDirty(true);
    if (posterInputRef.current) posterInputRef.current.value = "";
  }

  // Discard a staged (not-yet-saved) crop → revert to whatever poster was saved.
  function discardStagedPoster() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingPreviewUrl(null);
    setPendingBlob(null);
    if (posterInputRef.current) posterInputRef.current.value = "";
  }

  // Remove the poster. Staged-only → just drop the staging. Saved poster → DELETE immediately
  // (independent of the draft event fields) and clear the preview.
  async function handleRemovePoster() {
    if (pendingPreviewUrl) {
      discardStagedPoster();
      return;
    }
    if (!posterUrl || !eventId) return;
    setRemovingPoster(true);
    try {
      await apiDelete(`/admin/events/${eventId}/poster`);
      setPosterUrl(null);
      toast.success("ลบรูปภาพปกแล้ว");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถลบรูปภาพได้");
    } finally {
      setRemovingPoster(false);
    }
  }

  // Wrap a setter so any edit marks the form dirty + clears that field's inline error.
  function bind<T>(setter: (v: T) => void, field?: string) {
    return (v: T) => {
      setDirty(true);
      if (field) setErrors((prev) => (prev[field] ? omit(prev, field) : prev));
      setter(v);
    };
  }

  // Live slug-format check (advisory; backend normalizes/dedupes on save).
  const slugFormatError = useMemo(
    () => (publicSlug.trim() !== "" && !SLUG_OK.test(publicSlug.trim())
      ? "ใช้ได้เฉพาะตัวอักษร ตัวเลข และเครื่องหมายขีด (-) เท่านั้น"
      : null),
    [publicSlug],
  );

  // Scroll to + focus the first field that has an error (by name attribute).
  function scrollToFirstError(errs: Record<string, string>) {
    const first = Object.keys(errs)[0];
    if (!first || !formRef.current) return;
    const el = formRef.current.querySelector<HTMLElement>(`[data-field="${first}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.querySelector<HTMLElement>("input,textarea,[role=combobox]")?.focus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    // Build wire payload: nullable windows cleared when blank; numbers parsed; ISO strings for dates.
    const payload = {
      title: title.trim(),
      description: description.trim() === "" ? null : description.trim(),
      location: location.trim() === "" ? null : location.trim(),
      registrationMode,
      registrationOpenAt: bangkokInputToIso(registrationOpenAt),
      registrationCloseAt: bangkokInputToIso(registrationCloseAt),
      checkinOpenAt: bangkokInputToIso(checkinOpenAt),
      checkinCloseAt: bangkokInputToIso(checkinCloseAt),
      eventStartAt: bangkokInputToIso(eventStartAt),
      eventEndAt: bangkokInputToIso(eventEndAt),
      capacityEnabled,
      capacityLimit: capacityEnabled && capacityLimit !== "" ? Number(capacityLimit) : null,
      waitlistEnabled,
      allowStudentCancelRegistration: allowStudentCancel,
      cancelRegistrationCloseAt: bangkokInputToIso(cancelCloseAt),
      allowStudentEditRegistration: allowStudentEdit,
      editRegistrationCloseAt: bangkokInputToIso(editCloseAt),
      // Only send slug when non-empty (create auto-generates from title).
      ...(publicSlug.trim() !== "" ? { publicSlug: publicSlug.trim() } : {}),
    };

    // Collect per-field errors so we can mark + scroll to the offending field (not just toast the first).
    const fieldErrors: Record<string, string> = {};

    if (title.trim() === "") fieldErrors.title = "กรุณากรอกชื่อกิจกรรม";
    if (slugFormatError) fieldErrors.publicSlug = slugFormatError;

    // Capacity limit required when capacity enabled (mirrors backend invariant).
    if (capacityEnabled && (capacityLimit === "" || Number(capacityLimit) <= 0)) {
      fieldErrors.capacityLimit = "จำนวนที่รับต้องมากกว่า 0 เมื่อเปิดการจำกัดจำนวน";
    }

    // Each window's open must precede its close (only when both ends present).
    if (
      payload.registrationOpenAt &&
      payload.registrationCloseAt &&
      payload.registrationOpenAt >= payload.registrationCloseAt
    ) {
      fieldErrors.registrationCloseAt = "เวลาปิดลงทะเบียนต้องอยู่หลังเวลาเปิดลงทะเบียน";
    }
    if (
      payload.checkinOpenAt &&
      payload.checkinCloseAt &&
      payload.checkinOpenAt >= payload.checkinCloseAt
    ) {
      fieldErrors.checkinCloseAt = "เวลาปิดเช็คอินต้องอยู่หลังเวลาเปิดเช็คอิน";
    }
    if (
      payload.eventStartAt &&
      payload.eventEndAt &&
      payload.eventStartAt >= payload.eventEndAt
    ) {
      fieldErrors.eventEndAt = "เวลาสิ้นสุดกิจกรรมต้องอยู่หลังเวลาเริ่มกิจกรรม";
    }

    // Validate against the shared zod schema (coerces dates); map any issues onto their field.
    const schema = mode === "create" ? createEventSchema : updateEventSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      scrollToFirstError(fieldErrors);
      toast.error("กรุณาตรวจสอบข้อมูลในฟอร์ม");
      return;
    }
    setErrors({});

    setSaving(true);
    try {
      if (mode === "create") {
        const res = await apiPost<{ event: { id: string } }>("/admin/events", payload);
        setDirty(false); // saved → drop the unsaved-changes guard before navigating
        toast.success("สร้างกิจกรรมเป็นฉบับร่างแล้ว");
        router.push(`/admin/events/${res.event.id}`);
      } else {
        // 1) Event fields first.
        await apiPatch(`/admin/events/${eventId}`, payload);
        // 2) Then the staged poster (if any). If it fails, the event is already saved — warn, don't lose it.
        if (pendingBlob && eventId) {
          try {
            const fd = new FormData();
            // Filename ext MUST match the blob mime or the backend allow-list rejects it.
            const ext = pendingBlob.type === "image/png" ? "png" : "jpg";
            fd.append("file", pendingBlob, `poster.${ext}`);
            const res = await apiPostForm<{ event: EventAdmin }>(
              `/admin/events/${eventId}/poster`,
              fd,
            );
            // Backend embeds a ?v= cache-bust in posterImageUrl — use it as-is.
            setPosterUrl(res.event.posterImageUrl ?? null);
            if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
            setPendingPreviewUrl(null);
            setPendingBlob(null);
          } catch (err) {
            toast.warning(
              err instanceof ApiError
                ? `บันทึกกิจกรรมแล้ว แต่ไม่สามารถอัปโหลดรูปภาพได้: ${err.message}`
                : "บันทึกกิจกรรมแล้ว แต่ไม่สามารถอัปโหลดรูปภาพได้",
            );
          }
        }
        setDirty(false);
        toast.success("อัปเดตกิจกรรมแล้ว");
        router.push(`/admin/events/${eventId}`);
      }
    } catch (err) {
      // Slug collision (409) → attach to the slug field instead of an opaque toast.
      // (Backend currently auto-dedupes slugs, so this is a defensive guard for future strict mode.)
      if (err instanceof ApiError && (err.status === 409 || /slug/i.test(err.code))) {
        const slugMsg = "Slug นี้ถูกใช้แล้ว กรุณาเลือก slug อื่น";
        setErrors({ publicSlug: slugMsg });
        scrollToFirstError({ publicSlug: slugMsg });
        toast.error(slugMsg);
      } else {
        toast.error(err instanceof ApiError ? err.message : "ไม่สามารถบันทึกกิจกรรมได้");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
      {/* Poster — edit mode only (needs an existing eventId). Draft model: pick → crop → stage; upload on Save. */}
      {mode === "edit" && eventId ? (
        <Card>
          <CardHeader>
            <CardTitle>รูปภาพปก / ภาพกิจกรรม</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative aspect-[16/9] w-full max-w-md overflow-hidden rounded-lg border bg-muted">
              {pendingPreviewUrl ? (
                // Staged crop: blob: URL can't go through next/image, use a plain <img>.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pendingPreviewUrl}
                  alt="ตัวอย่างภาพปกที่ยังไม่บันทึก"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : posterUrl ? (
                <Image
                  src={`/api${posterUrl}`}
                  alt="ภาพปกกิจกรรม"
                  fill
                  sizes="(max-width: 768px) 100vw, 28rem"
                  className="object-cover"
                />
              ) : (
                // No poster set — explicit empty state (no decorative gallery fallback).
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <ImageOff className="h-8 w-8" />
                  <span className="text-sm">ยังไม่มีรูปภาพปก</span>
                </div>
              )}
              {pendingPreviewUrl ? (
                <span className="absolute left-2 top-2 rounded bg-amber-500 px-2 py-0.5 text-xs font-medium text-white shadow">
                  ยังไม่บันทึก
                </span>
              ) : null}
            </div>
            <input
              ref={posterInputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={handlePosterChange}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => posterInputRef.current?.click()}
              >
                อัปโหลดรูปภาพ
              </Button>
              {/* Show remove only when there's something to remove (staged crop or saved poster). */}
              {(pendingPreviewUrl || posterUrl) ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={handleRemovePoster}
                  disabled={removingPoster}
                >
                  {removingPoster ? "กำลังลบ…" : pendingPreviewUrl ? "ยกเลิกรูปที่เลือก" : "ลบรูปภาพ"}
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                PNG หรือ JPG • สูงสุด 5MB • บันทึกเมื่อกด “บันทึกการเปลี่ยนแปลง”
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <PosterCropDialog
        open={cropOpen}
        src={cropSrc}
        mime={cropMime}
        onCancel={handleCropCancel}
        onConfirm={handleCropConfirm}
      />

      <Card>
        <CardHeader>
          <CardTitle>ข้อมูลพื้นฐาน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="ชื่อกิจกรรม" required name="title" error={errors.title}>
            <Input value={title} onChange={(e) => bind(setTitle, "title")(e.target.value)} />
          </Field>
          <Field
            label="Slug"
            name="publicSlug"
            error={errors.publicSlug ?? slugFormatError ?? undefined}
            hint="เว้นว่างไว้เพื่อสร้างอัตโนมัติจากชื่อ • ใช้ได้เฉพาะตัวอักษร ตัวเลข และขีด (-) เช่น my-event"
          >
            <Input
              value={publicSlug}
              onChange={(e) => bind(setPublicSlug, "publicSlug")(e.target.value)}
              placeholder="my-event"
            />
          </Field>
          <Field label="รายละเอียด">
            <Textarea
              value={description}
              onChange={(e) => bind(setDescription)(e.target.value)}
              rows={4}
            />
          </Field>
          <Field label="สถานที่">
            <Input value={location} onChange={(e) => bind(setLocation)(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>การลงทะเบียน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="รูปแบบการลงทะเบียน"
            hint={
              registrationMode === "closed"
                ? "ค่าเริ่มต้นคือ 'ปิด' — นักศึกษายังลงทะเบียนเองไม่ได้จนกว่าจะเลือก 'ลงทะเบียนเองแบบสาธารณะ'"
                : undefined
            }
          >
            <Select
              value={registrationMode}
              onValueChange={(v) => bind(setRegistrationMode)(v as typeof registrationMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {registrationModeEnum.options.map((m) => (
                  <SelectItem key={m} value={m}>
                    {REG_MODE_LABEL[m] ?? m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {/* Window only enforced after publish — ties to the readiness rule. */}
          <p className="text-xs text-muted-foreground">
            ช่วงเวลาลงทะเบียนจะมีผลก็ต่อเมื่อเผยแพร่กิจกรรมแล้วเท่านั้น
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="เปิดลงทะเบียน (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={registrationOpenAt}
                onChange={(e) => bind(setRegistrationOpenAt)(e.target.value)}
              />
            </Field>
            <Field
              label="ปิดลงทะเบียน (เวลาไทย)"
              name="registrationCloseAt"
              error={errors.registrationCloseAt}
              hint="เว้นว่าง = ไม่มีกำหนด"
            >
              <Input
                type="datetime-local"
                value={registrationCloseAt}
                onChange={(e) => bind(setRegistrationCloseAt, "registrationCloseAt")(e.target.value)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>เวลากิจกรรมและเช็คอิน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="เริ่มกิจกรรม (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={eventStartAt}
                onChange={(e) => bind(setEventStartAt)(e.target.value)}
              />
            </Field>
            <Field
              label="สิ้นสุดกิจกรรม (เวลาไทย)"
              name="eventEndAt"
              error={errors.eventEndAt}
              hint="เว้นว่าง = ไม่มีกำหนด"
            >
              <Input
                type="datetime-local"
                value={eventEndAt}
                onChange={(e) => bind(setEventEndAt, "eventEndAt")(e.target.value)}
              />
            </Field>
            <Field label="เปิดเช็คอิน (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={checkinOpenAt}
                onChange={(e) => bind(setCheckinOpenAt)(e.target.value)}
              />
            </Field>
            <Field
              label="ปิดเช็คอิน (เวลาไทย)"
              name="checkinCloseAt"
              error={errors.checkinCloseAt}
              hint="เว้นว่าง = ไม่มีกำหนด"
            >
              <Input
                type="datetime-local"
                value={checkinCloseAt}
                onChange={(e) => bind(setCheckinCloseAt, "checkinCloseAt")(e.target.value)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>จำนวนที่รับและรายชื่อสำรอง</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Checkbox
            label="เปิดใช้งานการจำกัดจำนวนที่รับ"
            checked={capacityEnabled}
            // Turning capacity off makes waitlist meaningless — clear it too.
            onChange={bind((v: boolean) => {
              setCapacityEnabled(v);
              if (!v) setWaitlistEnabled(false);
            })}
            hint="นับเฉพาะผู้ที่ลงทะเบียนและเช็คอินแล้ว"
          />
          {capacityEnabled && (
            <Field label="จำนวนที่รับ" required name="capacityLimit" error={errors.capacityLimit}>
              <Input
                type="number"
                min={1}
                value={capacityLimit}
                onChange={(e) => bind(setCapacityLimit, "capacityLimit")(e.target.value)}
              />
            </Field>
          )}
          {/* Waitlist only makes sense with a capacity cap. */}
          <Checkbox
            label="เปิดใช้งานรายชื่อสำรองเมื่อเต็ม"
            checked={waitlistEnabled}
            onChange={bind(setWaitlistEnabled)}
            disabled={!capacityEnabled}
            hint={!capacityEnabled ? "ต้องเปิดการจำกัดจำนวนก่อน" : undefined}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>สิทธิ์ของนักศึกษา</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Checkbox
            label="อนุญาตให้นักศึกษายกเลิกการลงทะเบียนของตนเอง"
            checked={allowStudentCancel}
            onChange={bind(setAllowStudentCancel)}
          />
          {allowStudentCancel && (
            <Field label="ปิดการยกเลิก (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนดเวลา">
              <Input
                type="datetime-local"
                value={cancelCloseAt}
                onChange={(e) => bind(setCancelCloseAt)(e.target.value)}
              />
            </Field>
          )}
          <Separator />
          <Checkbox
            label="อนุญาตให้นักศึกษาแก้ไขคำตอบของตนเอง"
            checked={allowStudentEdit}
            onChange={bind(setAllowStudentEdit)}
          />
          {allowStudentEdit && (
            <Field label="ปิดการแก้ไข (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนดเวลา">
              <Input
                type="datetime-local"
                value={editCloseAt}
                onChange={(e) => bind(setEditCloseAt)(e.target.value)}
              />
            </Field>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Make the draft rule visible before submit (was only a post-submit toast). */}
        {mode === "create" ? (
          <span className="mr-auto text-xs text-muted-foreground">
            กิจกรรมจะถูกสร้างเป็น “ฉบับร่าง” — เผยแพร่ภายหลังจากหน้าภาพรวม
          </span>
        ) : null}
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={saving}>
          ยกเลิก
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "กำลังบันทึก…" : mode === "create" ? "สร้างกิจกรรม" : "บันทึกการเปลี่ยนแปลง"}
        </Button>
      </div>
    </form>
  );
}

// Small labelled field wrapper. `name` tags the field for scroll-to-error; `error` shows inline.
function Field({
  label,
  required,
  hint,
  name,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  name?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5" data-field={name}>
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

// Plain checkbox row (no shadcn checkbox primitive in the foundation — use native input).
// Optional `disabled` + `hint` added for dependent toggles (e.g. waitlist needs capacity on).
function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label
        className={`flex items-center gap-2 text-sm ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {label}
      </label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
