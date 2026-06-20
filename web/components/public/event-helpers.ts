// Shared, pure helpers for public event pages. No I/O — derive UI state from an EventPublic.
import type { EventPublic, RegistrationStatus } from "@/lib/types";
import { formSchema, type FormSchema } from "@/lib/schemas";
import { formatBangkok } from "@/lib/time";

// Deterministically pick one of the 16 gallery photos for an event (stable per id/slug).
export function galleryImage(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `/gallery/event-${(hash % 16) + 1}.jpg`;
}

// Event hero/thumbnail src: uploaded poster (served via /api proxy) when set, else a stable gallery photo.
export function eventThumbnail(e: Pick<EventPublic, "posterImageUrl" | "publicId" | "publicSlug" | "id">): string {
  if (e.posterImageUrl) return `/api${e.posterImageUrl}`;
  return galleryImage(e.publicId || e.publicSlug || e.id);
}

// Human event-time range in Bangkok. Falls back gracefully when start/end missing.
export function eventTimeRange(e: Pick<EventPublic, "eventStartAt" | "eventEndAt">): string {
  const start = formatBangkok(e.eventStartAt);
  const end = formatBangkok(e.eventEndAt);
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  return "จะประกาศวันและเวลาภายหลัง";
}

// Capacity display: "42 / 100", "ลงทะเบียนแล้ว 42 คน", or null when not meaningful.
export function capacityLabel(e: EventPublic): string | null {
  if (e.capacityEnabled && typeof e.capacityLimit === "number") {
    return `${e.registeredCount} / ${e.capacityLimit}`;
  }
  if (typeof e.registeredCount === "number") return `ลงทะเบียนแล้ว ${e.registeredCount} คน`;
  return null;
}

// Seats remaining for a capacity-enabled event, clamped at 0. null when capacity isn't tracked.
export function seatsRemaining(e: EventPublic): number | null {
  if (!e.capacityEnabled || typeof e.capacityLimit !== "number") return null;
  return Math.max(0, e.capacityLimit - (e.registeredCount ?? 0));
}

// True when capacity is enabled AND the limit has been reached (count >= limit).
export function isFull(e: EventPublic): boolean {
  return e.capacityEnabled && typeof e.capacityLimit === "number" && e.registeredCount >= e.capacityLimit;
}

// Is "now" inside the registration window? Open/close nulls mean "unbounded on that side".
function inRegistrationWindow(e: EventPublic, now = new Date()): boolean {
  const open = e.registrationOpenAt ? new Date(e.registrationOpenAt) : null;
  const close = e.registrationCloseAt ? new Date(e.registrationCloseAt) : null;
  if (open && now < open) return false;
  if (close && now > close) return false;
  return true;
}

export type RegistrationAction =
  | { kind: "already_registered"; registrationId: string; status: RegistrationStatus } // viewer already holds a (non-cancelled) reg
  | { kind: "register" } // self-register available now
  | { kind: "students_only" } // logged-in non-student (admin/staff) — registration is student-only
  | { kind: "waitlist" } // full but waitlist enabled
  | { kind: "full" } // full, no waitlist
  | { kind: "not_open"; reason: string } // window not open / closed
  | { kind: "closed_mode" } // event not accepting public self-registration
  | { kind: "cancelled" } // event cancelled
  | { kind: "archived" } // archived → read-only
  | { kind: "unavailable" }; // draft / unexpected — no public action

// The single source of truth for which action (if any) a public visitor can take.
// Mirrors spec §16: draft→none, published→by mode/window/capacity, cancelled→none, archived→read-only.
export function registrationAction(e: EventPublic, now = new Date()): RegistrationAction {
  // Viewer already holds a registration → takes precedence over any register/waitlist/full CTA.
  // Backend omits these fields for cancelled regs, so a cancelled viewer can still re-register below.
  if (e.myRegistrationId) {
    return {
      kind: "already_registered",
      registrationId: e.myRegistrationId,
      status: e.myRegistrationStatus ?? "registered",
    };
  }
  if (e.status === "cancelled") return { kind: "cancelled" };
  if (e.status === "archived") return { kind: "archived" };
  if (e.status !== "published") return { kind: "unavailable" };

  // Only public self-register events expose a public register button.
  if (e.registrationMode !== "public_self_register") return { kind: "closed_mode" };

  if (!inRegistrationWindow(e, now)) {
    const open = e.registrationOpenAt ? new Date(e.registrationOpenAt) : null;
    if (open && now < open) {
      return { kind: "not_open", reason: `เปิดรับลงทะเบียน ${formatBangkok(e.registrationOpenAt)}` };
    }
    return { kind: "not_open", reason: "ปิดรับลงทะเบียนแล้ว" };
  }

  if (isFull(e)) {
    return e.waitlistEnabled ? { kind: "waitlist" } : { kind: "full" };
  }
  return { kind: "register" };
}

// The event's active form may be a bare FormSchema, a { schema } wrapper, or absent. Returns a
// validated schema with at least one field, else null (null → register posts an empty body).
export function extractEventForm(e: EventPublic): FormSchema | null {
  const raw = e.form;
  if (!raw) return null;
  const candidate = "schema" in raw ? raw.schema : raw;
  const parsed = formSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.fields.length === 0) return null;
  return parsed.data;
}

// Should this event appear in the PUBLIC list? published+listed always; cancelled+listed yes (badge).
export function isPubliclyListed(e: EventPublic): boolean {
  if (e.visibility !== "listed") return false;
  return e.status === "published" || e.status === "cancelled";
}
