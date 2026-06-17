"use client";

// Permanent QR redirect target. GET /api/e/:publicId resolves to the current slug → redirect.
// Fallback: if the resolve endpoint returns the event directly, render it here instead of redirecting.
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api";
import type { EventPublic } from "@/lib/types";
import { PublicShell } from "@/components/public/public-shell";
import { EventStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { galleryImage, eventTimeRange } from "@/components/public/event-helpers";

// Resolve response may be a redirect hint ({ slug }/{ publicSlug }) or a full event object.
type ResolveResponse = Partial<EventPublic> & { slug?: string };

export default function PublicIdRedirectPage() {
  const params = useParams<{ publicId: string }>();
  const publicId = params.publicId;
  const router = useRouter();

  const [event, setEvent] = useState<EventPublic | null>(null);
  const [state, setState] = useState<"loading" | "fallback" | "notfound" | "error">("loading");

  useEffect(() => {
    let active = true;
    async function resolve() {
      try {
        const data = await apiGet<ResolveResponse>(`/e/${publicId}`);
        if (!active) return;
        const slug = data.publicSlug ?? data.slug;
        // Preferred path: forward to the canonical event page.
        if (slug) {
          router.replace(`/events/${slug}`);
          return;
        }
        // Fallback: backend returned a full event object — render it here.
        if (data.id && data.title) {
          setEvent(data as EventPublic);
          setState("fallback");
          return;
        }
        setState("notfound");
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setState("notfound");
          return;
        }
        setState("error");
      }
    }
    if (publicId) void resolve();
    return () => {
      active = false;
    };
  }, [publicId, router]);

  return (
    <PublicShell>
      {state === "loading" ? (
        <div className="space-y-4">
          <Skeleton className="aspect-[16/7] w-full rounded-xl" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : state === "fallback" && event ? (
        <FallbackEvent event={event} />
      ) : state === "notfound" ? (
        <div className="rounded-lg border border-dashed py-20 text-center">
          <h1 className="text-lg font-semibold">Event not found</h1>
          <p className="mt-1 text-sm text-muted-foreground">This link doesn’t point to a valid event.</p>
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link href="/events">Back to events</Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed py-20 text-center">
          <p className="text-sm text-muted-foreground">Couldn’t open this event link. Please try again.</p>
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link href="/events">Back to events</Link>
          </Button>
        </div>
      )}
    </PublicShell>
  );
}

function FallbackEvent({ event }: { event: EventPublic }) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="relative mb-6 aspect-[16/7] w-full overflow-hidden rounded-xl bg-muted">
        <Image
          src={galleryImage(event.publicId || event.publicSlug || event.id)}
          alt=""
          fill
          sizes="(max-width: 1024px) 100vw, 66vw"
          className="object-cover"
          priority
        />
        <div className="absolute left-3 top-3">
          <EventStatusBadge status={event.status} />
        </div>
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{event.title}</h1>
      <Card className="mt-4">
        <CardContent className="space-y-2 p-5">
          <p className="text-sm text-muted-foreground">{eventTimeRange(event)}</p>
          {event.location ? <p className="text-sm">{event.location}</p> : null}
          {event.publicSlug ? (
            <Button className="mt-2" asChild>
              <Link href={`/events/${event.publicSlug}`}>Open event page</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
