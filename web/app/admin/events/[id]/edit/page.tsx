"use client";

// Edit event. Loads the full admin row (GET /admin/events/:id), then PATCHes.
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventAdmin } from "@/lib/types";
import { EventForm } from "@/components/admin-events/event-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<EventAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Detail returns { event, computed }; we only need the event row for the form.
    apiGet<{ event: EventAdmin }>(`/admin/events/${id}`)
      .then((res) => active && setEvent(res.event))
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : "Failed to load event.");
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/events/${id}`}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">Edit event</h1>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!event && !error ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : event ? (
        <EventForm mode="edit" eventId={id} initial={event} />
      ) : null}
    </div>
  );
}
