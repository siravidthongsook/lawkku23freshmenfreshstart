import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { events, type Event } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { isWithinWindow, effectiveCheckinClose } from "../../lib/time";

// slugify: lowercase, strip non-alphanumerics → hyphen, trim. Keeps thai/unicode letters as-is.
export function slugify(input: string): string {
  const base = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, "-") // whitespace/underscore → hyphen
    .replace(/[^\p{L}\p{N}-]+/gu, "") // drop anything not letter/number/hyphen
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "event"; // never empty
}

// Ensure slug uniqueness by appending -2, -3, ... Excludes a given event id (for edits).
export async function ensureUniqueSlug(
  exec: Tx | typeof db,
  desired: string,
  excludeEventId?: string,
): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  let n = 1;
  // Loop until no collision; small N expected for an internal single-site system.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await exec
      .select({ id: events.id })
      .from(events)
      .where(
        excludeEventId
          ? and(eq(events.publicSlug, candidate), ne(events.id, excludeEventId))
          : eq(events.publicSlug, candidate),
      )
      .limit(1);
    if (rows.length === 0) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

// Capacity count = registered + checked_in only (excludes cancelled, waitlisted).
export async function countActiveRegistrations(
  exec: Tx | typeof db,
  eventId: string,
): Promise<number> {
  const [row] = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        sql`${registrations.status} in ('registered','checked_in')`,
      ),
    );
  return row?.c ?? 0;
}

// Computed view fields used by public/admin event responses.
export type EventComputed = {
  registrationOpen: boolean;
  checkinOpen: boolean;
  capacity: {
    enabled: boolean;
    limit: number | null;
    used: number;
    full: boolean;
  };
};

// Build computed window/capacity status for an event. `now` injected for testability.
export async function computeEventStatus(
  event: Event,
  opts: { now?: Date; activeCount?: number } = {},
): Promise<EventComputed> {
  const now = opts.now ?? new Date();
  const used =
    opts.activeCount ?? (await countActiveRegistrations(db, event.id));
  const full = event.capacityEnabled && event.capacityLimit != null && used >= event.capacityLimit;

  // Registration window: only meaningful when event published and mode allows self-register.
  const registrationOpen =
    event.status === "published" &&
    event.registrationMode === "public_self_register" &&
    isWithinWindow(now, event.registrationOpenAt, event.registrationCloseAt) &&
    !full;

  // Effective close = explicit close, else event end (scan-in must not outlast the event).
  const checkinOpen =
    event.status === "published" &&
    isWithinWindow(now, event.checkinOpenAt, effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt));

  return {
    registrationOpen,
    checkinOpen,
    capacity: {
      enabled: event.capacityEnabled,
      limit: event.capacityLimit,
      used,
      full,
    },
  };
}

// Server-computed effective registration state for an event (admin list/overview).
// Single source of truth so the list badge stops drifting from the detail page's `computed`.
// Mirrors computeEventStatus's self-register rule but collapses to one label kind.
export type EventEffectiveState =
  | "draft"
  | "cancelled"
  | "archived"
  | "open" // published + self-register + within window + not full
  | "full" // published + self-register + within window but capacity full
  | "not_open" // published + self-register but outside the window
  | "closed_mode"; // published but registrationMode isn't self-register

export function effectiveState(event: Event, computed: EventComputed): EventEffectiveState {
  if (event.status === "draft") return "draft";
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "archived") return "archived";
  // published
  if (event.registrationMode !== "public_self_register") return "closed_mode";
  if (computed.registrationOpen) return "open";
  if (computed.capacity.full) return "full";
  return "not_open";
}

// Per-status registration counts for many events in one query (avoids N+1 on the admin list).
export async function countRegistrationsByStatusForEvents(
  eventIds: string[],
): Promise<Map<string, { registered: number; waitlisted: number; checked_in: number; cancelled: number }>> {
  const result = new Map<
    string,
    { registered: number; waitlisted: number; checked_in: number; cancelled: number }
  >();
  for (const id of eventIds) {
    result.set(id, { registered: 0, waitlisted: 0, checked_in: 0, cancelled: 0 });
  }
  if (eventIds.length === 0) return result;
  const rows = await db
    .select({
      eventId: registrations.eventId,
      status: registrations.status,
      c: sql<number>`count(*)::int`,
    })
    .from(registrations)
    .where(inArray(registrations.eventId, eventIds))
    .groupBy(registrations.eventId, registrations.status);
  for (const row of rows) {
    const entry = result.get(row.eventId);
    if (entry) entry[row.status] = row.c;
  }
  return result;
}

// Public-safe projection — no internal admin/audit fields. Shape MUST match the frontend
// `EventPublic` contract (web/lib/types.ts): the public list/detail pages consume these field
// names directly. Computed open/full state is derived client-side from windows+capacity, so we
// expose the raw inputs (windows, capacityLimit, registeredCount) rather than the computed object.
export function publicEventView(event: Event, computed: EventComputed) {
  return {
    id: event.id,
    publicId: event.publicId,
    publicSlug: event.publicSlug,
    title: event.title,
    description: event.description,
    location: event.location,
    posterImageUrl: event.posterImageUrl, // null when no poster set
    status: event.status, // published | cancelled | archived (draft never reaches here)
    visibility: event.visibility,
    registrationMode: event.registrationMode,
    registrationOpenAt: event.registrationOpenAt,
    registrationCloseAt: event.registrationCloseAt,
    checkinOpenAt: event.checkinOpenAt,
    checkinCloseAt: event.checkinCloseAt,
    eventStartAt: event.eventStartAt,
    eventEndAt: event.eventEndAt,
    capacityEnabled: event.capacityEnabled,
    capacityLimit: event.capacityLimit,
    registeredCount: computed.capacity.used, // active = registered + checked_in
    waitlistEnabled: event.waitlistEnabled,
  };
}
