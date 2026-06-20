// Public event list card. Gallery hero + title, time (Bangkok), capacity, status badge.
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { EventStatusBadge } from "@/components/badges";
import type { EventPublic } from "@/lib/types";
import { eventTimeRange, capacityLabel, isFull, isOngoing } from "@/components/public/event-helpers";
import { EventPoster } from "@/components/public/event-poster";

export function EventCard({ event }: { event: EventPublic }) {
  const cap = capacityLabel(event);
  const full = isFull(event);
  const ongoing = isOngoing(event);

  return (
    <Link href={`/events/${event.publicSlug}`} className="group block focus-visible:outline-none">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
          <EventPoster
            event={event}
            sizes="(max-width: 768px) 100vw, 33vw"
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {/* Students only ever see published events — "เผยแพร่แล้ว" is admin noise. Flag only exceptional states (e.g. cancelled). */}
          {event.status !== "published" ? (
            <div className="absolute left-2 top-2">
              <EventStatusBadge status={event.status} />
            </div>
          ) : null}
          {/* Top-right status pills, stacked. Pre-click signals so students don't open the event to find out. */}
          {(event.myRegistrationId || ongoing) ? (
            <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
              {/* Live now: event has started and not yet ended. Pulsing dot to read as "active". */}
              {ongoing ? (
                <span className="flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium text-white shadow">
                  <span className="size-1.5 animate-pulse rounded-full bg-white" />
                  กำลังดำเนินอยู่
                </span>
              ) : null}
              {/* Viewer already holds a (non-cancelled) reg for this event. */}
              {event.myRegistrationId ? (
                <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white shadow">
                  {event.myRegistrationStatus === "waitlisted" ? "อยู่ในรายชื่อสำรอง" : "ลงทะเบียนแล้ว"}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <CardContent className="space-y-2 p-4">
          <h3 className="line-clamp-2 text-base font-semibold leading-snug">{event.title}</h3>
          <p className="text-sm text-muted-foreground">{eventTimeRange(event)}</p>
          {event.location ? (
            <p className="line-clamp-1 text-sm text-muted-foreground">{event.location}</p>
          ) : null}
          {cap ? (
            <p className="text-xs font-medium text-muted-foreground">
              {cap}
              {full ? <span className="ml-1 text-amber-600">· เต็มแล้ว</span> : null}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}
