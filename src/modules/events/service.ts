import { and, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { events, type Event } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { isWithinWindow } from "../../lib/time";

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

  const checkinOpen =
    event.status === "published" &&
    isWithinWindow(now, event.checkinOpenAt, event.checkinCloseAt);

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

// Public-safe projection — no internal admin/audit fields, status surfaced for badges.
export function publicEventView(event: Event, computed: EventComputed) {
  return {
    publicId: event.publicId,
    slug: event.publicSlug,
    title: event.title,
    description: event.description,
    location: event.location,
    status: event.status, // published | cancelled | archived (draft never reaches here)
    cancelled: event.status === "cancelled",
    archived: event.status === "archived", // read-only when true
    registrationMode: event.registrationMode,
    registrationOpenAt: event.registrationOpenAt,
    registrationCloseAt: event.registrationCloseAt,
    eventStartAt: event.eventStartAt,
    eventEndAt: event.eventEndAt,
    waitlistEnabled: event.waitlistEnabled,
    ...computed,
  };
}
