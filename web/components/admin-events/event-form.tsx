"use client";

// Shared create/edit event form. Used by /admin/events/new (mode="create") and /admin/events/[id]/edit.
// Validates with createEventSchema/updateEventSchema before sending; sends ISO-UTC strings (backend coerces).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, apiPatch, ApiError } from "@/lib/api";
import {
  createEventSchema,
  updateEventSchema,
  registrationModeEnum,
} from "@/lib/schemas";
import type { EventAdmin } from "@/lib/types";
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
import { isoToBangkokInput, bangkokInputToIso } from "./datetime";

type Mode = "create" | "edit";

// Loose initial shape — EventAdmin in edit mode, undefined in create. Backend returns raw row.
type Props = {
  mode: Mode;
  eventId?: string;
  initial?: Partial<EventAdmin> | null;
};

const REG_MODE_LABEL: Record<string, string> = {
  public_self_register: "เปิดให้ลงทะเบียนเองแบบสาธารณะ",
  admin_import_only: "นำเข้าโดยผู้ดูแลเท่านั้น",
  closed: "ปิด",
};

export function EventForm({ mode, eventId, initial }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

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

    // Client-side guard: capacity limit required when capacity enabled (mirrors backend invariant).
    if (capacityEnabled && (capacityLimit === "" || Number(capacityLimit) <= 0)) {
      toast.error("จำนวนที่รับต้องมากกว่า 0 เมื่อเปิดการจำกัดจำนวน");
      return;
    }

    // Client-side guard: each window's open must precede its close (only when both ends present).
    if (
      payload.registrationOpenAt &&
      payload.registrationCloseAt &&
      payload.registrationOpenAt >= payload.registrationCloseAt
    ) {
      toast.error("เวลาเปิดลงทะเบียนต้องอยู่ก่อนเวลาปิดลงทะเบียน");
      return;
    }
    if (
      payload.checkinOpenAt &&
      payload.checkinCloseAt &&
      payload.checkinOpenAt >= payload.checkinCloseAt
    ) {
      toast.error("เวลาเปิดเช็คอินต้องอยู่ก่อนเวลาปิดเช็คอิน");
      return;
    }
    if (
      payload.eventStartAt &&
      payload.eventEndAt &&
      payload.eventStartAt >= payload.eventEndAt
    ) {
      toast.error("เวลาเริ่มกิจกรรมต้องอยู่ก่อนเวลาสิ้นสุดกิจกรรม");
      return;
    }

    // Validate against the shared zod schema (coerces dates) before hitting the API.
    const schema = mode === "create" ? createEventSchema : updateEventSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "กรุณาตรวจสอบข้อมูลในฟอร์ม");
      return;
    }

    setSaving(true);
    try {
      if (mode === "create") {
        const res = await apiPost<{ event: { id: string } }>("/admin/events", payload);
        toast.success("สร้างกิจกรรมเป็นฉบับร่างแล้ว");
        router.push(`/admin/events/${res.event.id}`);
      } else {
        await apiPatch(`/admin/events/${eventId}`, payload);
        toast.success("อัปเดตกิจกรรมแล้ว");
        router.push(`/admin/events/${eventId}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ไม่สามารถบันทึกกิจกรรมได้";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>ข้อมูลพื้นฐาน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="ชื่อกิจกรรม" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label="Slug" hint="เว้นว่างไว้เพื่อสร้างอัตโนมัติจากชื่อ">
            <Input
              value={publicSlug}
              onChange={(e) => setPublicSlug(e.target.value)}
              placeholder="my-event"
            />
          </Field>
          <Field label="รายละเอียด">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </Field>
          <Field label="สถานที่">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>การลงทะเบียน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="รูปแบบการลงทะเบียน">
            <Select
              value={registrationMode}
              onValueChange={(v) => setRegistrationMode(v as typeof registrationMode)}
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
                onChange={(e) => setRegistrationOpenAt(e.target.value)}
              />
            </Field>
            <Field label="ปิดลงทะเบียน (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={registrationCloseAt}
                onChange={(e) => setRegistrationCloseAt(e.target.value)}
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
                onChange={(e) => setEventStartAt(e.target.value)}
              />
            </Field>
            <Field label="สิ้นสุดกิจกรรม (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={eventEndAt}
                onChange={(e) => setEventEndAt(e.target.value)}
              />
            </Field>
            <Field label="เปิดเช็คอิน (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={checkinOpenAt}
                onChange={(e) => setCheckinOpenAt(e.target.value)}
              />
            </Field>
            <Field label="ปิดเช็คอิน (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนด">
              <Input
                type="datetime-local"
                value={checkinCloseAt}
                onChange={(e) => setCheckinCloseAt(e.target.value)}
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
            onChange={(v) => {
              setCapacityEnabled(v);
              if (!v) setWaitlistEnabled(false);
            }}
            hint="นับเฉพาะผู้ที่ลงทะเบียนและเช็คอินแล้ว"
          />
          {capacityEnabled && (
            <Field label="จำนวนที่รับ" required>
              <Input
                type="number"
                min={1}
                value={capacityLimit}
                onChange={(e) => setCapacityLimit(e.target.value)}
              />
            </Field>
          )}
          {/* Waitlist only makes sense with a capacity cap. */}
          <Checkbox
            label="เปิดใช้งานรายชื่อสำรองเมื่อเต็ม"
            checked={waitlistEnabled}
            onChange={setWaitlistEnabled}
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
            onChange={setAllowStudentCancel}
          />
          {allowStudentCancel && (
            <Field label="ปิดการยกเลิก (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนดเวลา">
              <Input
                type="datetime-local"
                value={cancelCloseAt}
                onChange={(e) => setCancelCloseAt(e.target.value)}
              />
            </Field>
          )}
          <Separator />
          <Checkbox
            label="อนุญาตให้นักศึกษาแก้ไขคำตอบของตนเอง"
            checked={allowStudentEdit}
            onChange={setAllowStudentEdit}
          />
          {allowStudentEdit && (
            <Field label="ปิดการแก้ไข (เวลาไทย)" hint="เว้นว่าง = ไม่มีกำหนดเวลา">
              <Input
                type="datetime-local"
                value={editCloseAt}
                onChange={(e) => setEditCloseAt(e.target.value)}
              />
            </Field>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
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

// Small labelled field wrapper.
function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
          className="size-4 rounded border-input"
        />
        {label}
      </label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
