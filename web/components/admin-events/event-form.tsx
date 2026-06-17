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
  public_self_register: "Public self-register",
  admin_import_only: "Admin / import only",
  closed: "Closed",
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
      toast.error("Capacity limit must be a positive number when capacity is enabled.");
      return;
    }

    // Validate against the shared zod schema (coerces dates) before hitting the API.
    const schema = mode === "create" ? createEventSchema : updateEventSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Please check the form fields.");
      return;
    }

    setSaving(true);
    try {
      if (mode === "create") {
        const res = await apiPost<{ event: { id: string } }>("/admin/events", payload);
        toast.success("Event created as draft.");
        router.push(`/admin/events/${res.event.id}`);
      } else {
        await apiPatch(`/admin/events/${eventId}`, payload);
        toast.success("Event updated.");
        router.push(`/admin/events/${eventId}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to save event.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label="Slug" hint="Leave blank to auto-generate from the title.">
            <Input
              value={publicSlug}
              onChange={(e) => setPublicSlug(e.target.value)}
              placeholder="my-event"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </Field>
          <Field label="Location">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Registration mode">
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Registration opens (Bangkok)">
              <Input
                type="datetime-local"
                value={registrationOpenAt}
                onChange={(e) => setRegistrationOpenAt(e.target.value)}
              />
            </Field>
            <Field label="Registration closes (Bangkok)">
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
          <CardTitle>Event & check-in times</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Event starts (Bangkok)">
              <Input
                type="datetime-local"
                value={eventStartAt}
                onChange={(e) => setEventStartAt(e.target.value)}
              />
            </Field>
            <Field label="Event ends (Bangkok)">
              <Input
                type="datetime-local"
                value={eventEndAt}
                onChange={(e) => setEventEndAt(e.target.value)}
              />
            </Field>
            <Field label="Check-in opens (Bangkok)">
              <Input
                type="datetime-local"
                value={checkinOpenAt}
                onChange={(e) => setCheckinOpenAt(e.target.value)}
              />
            </Field>
            <Field label="Check-in closes (Bangkok)">
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
          <CardTitle>Capacity & waitlist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Checkbox
            label="Enable capacity limit"
            checked={capacityEnabled}
            onChange={setCapacityEnabled}
          />
          {capacityEnabled && (
            <Field label="Capacity limit" required>
              <Input
                type="number"
                min={1}
                value={capacityLimit}
                onChange={(e) => setCapacityLimit(e.target.value)}
              />
            </Field>
          )}
          <Checkbox
            label="Enable waitlist when full"
            checked={waitlistEnabled}
            onChange={setWaitlistEnabled}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Student self-service</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Checkbox
            label="Allow students to cancel their registration"
            checked={allowStudentCancel}
            onChange={setAllowStudentCancel}
          />
          {allowStudentCancel && (
            <Field label="Cancellation closes (Bangkok)" hint="Blank = no deadline.">
              <Input
                type="datetime-local"
                value={cancelCloseAt}
                onChange={(e) => setCancelCloseAt(e.target.value)}
              />
            </Field>
          )}
          <Separator />
          <Checkbox
            label="Allow students to edit their answers"
            checked={allowStudentEdit}
            onChange={setAllowStudentEdit}
          />
          {allowStudentEdit && (
            <Field label="Editing closes (Bangkok)" hint="Blank = no deadline.">
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
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : mode === "create" ? "Create event" : "Save changes"}
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
function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-input"
      />
      {label}
    </label>
  );
}
