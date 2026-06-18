// Public event list card. Gallery hero + title, time (Bangkok), capacity, status badge.
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { EventStatusBadge } from "@/components/badges";
import type { EventPublic } from "@/lib/types";
import { galleryImage, eventTimeRange, capacityLabel, isFull } from "@/components/public/event-helpers";

export function EventCard({ event }: { event: EventPublic }) {
  const cap = capacityLabel(event);
  const full = isFull(event);

  return (
    <Link href={`/events/${event.publicSlug}`} className="group block focus-visible:outline-none">
      <Card className="overflow-hidden transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
          <Image
            src={galleryImage(event.publicId || event.publicSlug || event.id)}
            alt=""
            fill
            sizes="(max-width: 768px) 100vw, 33vw"
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {/* Students only ever see published events — "เผยแพร่แล้ว" is admin noise. Flag only exceptional states (e.g. cancelled). */}
          {event.status !== "published" ? (
            <div className="absolute left-2 top-2">
              <EventStatusBadge status={event.status} />
            </div>
          ) : null}
          {/* Pre-click signal: viewer already holds a (non-cancelled) reg for this event → don't make them re-open to find out. */}
          {event.myRegistrationId ? (
            <div className="absolute right-2 top-2 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white shadow">
              {event.myRegistrationStatus === "waitlisted" ? "อยู่ในรายชื่อสำรอง" : "ลงทะเบียนแล้ว"}
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
