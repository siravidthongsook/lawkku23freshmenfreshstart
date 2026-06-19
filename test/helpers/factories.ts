import { db } from "../../src/db/client";
import { events, type Event } from "../../src/db/schema/events";
import { registrations, type Registration } from "../../src/db/schema/registrations";
import type { User } from "../../src/db/schema/users";
import { seedUser } from "./auth";

let seq = 0; // unique slugs across a worker

export type MakeEventOptions = {
  createdByAdminId?: string; // auto-seeds an admin if omitted
  title?: string;
  publicSlug?: string;
  status?: Event["status"]; // default: published (so registration paths are reachable)
  registrationMode?: Event["registrationMode"]; // default: public_self_register
  visibility?: Event["visibility"];
  capacity?: number | null; // sets capacityEnabled + capacityLimit together
  registrationOpenAt?: Date | null;
  registrationCloseAt?: Date | null;
  checkinOpenAt?: Date | null;
  checkinCloseAt?: Date | null;
};

// Insert an event with registration-ready defaults. Pass `capacity` to enable a hard limit;
// omit it for unlimited. Auto-seeds an admin owner when createdByAdminId isn't given.
export async function makeEvent(opts: MakeEventOptions = {}): Promise<Event> {
  const n = ++seq;
  const adminId = opts.createdByAdminId ?? (await seedUser({ role: "admin" })).id;
  const hasCapacity = opts.capacity !== undefined && opts.capacity !== null;

  const [row] = await db
    .insert(events)
    .values({
      title: opts.title ?? `Test Event ${n}`,
      publicSlug: opts.publicSlug ?? `test-event-${n}`,
      status: opts.status ?? "published",
      registrationMode: opts.registrationMode ?? "public_self_register",
      visibility: opts.visibility ?? "listed",
      capacityEnabled: hasCapacity,
      capacityLimit: hasCapacity ? opts.capacity : null,
      registrationOpenAt: opts.registrationOpenAt ?? null,
      registrationCloseAt: opts.registrationCloseAt ?? null,
      checkinOpenAt: opts.checkinOpenAt ?? null,
      checkinCloseAt: opts.checkinCloseAt ?? null,
      createdByAdminId: adminId,
    })
    .returning();
  if (!row) throw new Error("makeEvent: insert returned no row");
  return row;
}

export type MakeRegistrationOptions = {
  event?: Event; // auto-makes one if omitted
  user?: User; // auto-seeds a student if omitted
  status?: Registration["status"]; // default: registered
  registeredAt?: Date | null;
};

// Insert a registration for (event, user). Auto-creates the event and a student user when not
// supplied. Sets registeredAt for the active statuses so capacity counts behave realistically.
export async function makeRegistration(
  opts: MakeRegistrationOptions = {},
): Promise<Registration> {
  const event = opts.event ?? (await makeEvent());
  const user = opts.user ?? (await seedUser({ role: "student" }));
  const status = opts.status ?? "registered";
  const active = status === "registered" || status === "checked_in";

  const [row] = await db
    .insert(registrations)
    .values({
      eventId: event.id,
      userId: user.id,
      status,
      registeredAt: opts.registeredAt ?? (active ? new Date() : null),
    })
    .returning();
  if (!row) throw new Error("makeRegistration: insert returned no row");
  return row;
}
