"use client";

// Public event list: published+listed (and cancelled+listed w/ badge). Hides draft/unlisted/archived.
import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventPublic } from "@/lib/types";
import { PublicShell } from "@/components/public/public-shell";
import { EventCard } from "@/components/public/event-card";
import { isPubliclyListed } from "@/components/public/event-helpers";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function EventsPage() {
  const [events, setEvents] = useState<EventPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<EventPublic[]>("/events");
      // Defensive: backend should already filter, but enforce public-visibility rules client-side too.
      setEvents((Array.isArray(data) ? data : []).filter(isPubliclyListed));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load events");
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <PublicShell>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Upcoming events</h1>
        <p className="text-sm text-muted-foreground">Browse and register for student events.</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="aspect-[16/9] w-full rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : events && events.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">No events are open right now. Check back soon.</p>
        </div>
      )}
    </PublicShell>
  );
}
