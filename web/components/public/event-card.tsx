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
          <div className="absolute left-2 top-2">
            <EventStatusBadge status={event.status} />
          </div>
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
              {full ? <span className="ml-1 text-amber-600">· Full</span> : null}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}
