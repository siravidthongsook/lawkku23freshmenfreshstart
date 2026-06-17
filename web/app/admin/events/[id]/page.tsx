"use client";

// Event Overview (dashboard L1). GET /admin/events/:id → { event, computed }.
// Counts/capacity status, window statuses, status + visibility changers, links to form/registrations/export.
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Users, Download, Pencil } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import {
  eventStatusEnum,
  eventVisibilityEnum,
} from "@/lib/schemas";
import type { EventAdmin, EventStatus, EventVisibility } from "@/lib/types";
import { formatBangkok } from "@/lib/time";
import { EventStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Computed status block returned alongside the event (events service: computeEventStatus).
type EventComputed = {
  registrationOpen: boolean;
  checkinOpen: boolean;
  capacity: { enabled: boolean; limit: number | null; used: number; full: boolean };
};

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  published: "Published",
  cancelled: "Cancelled",
  archived: "Archived",
};

export default function EventOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<EventAdmin | null>(null);
  const [computed, setComputed] = useState<EventComputed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ event: EventAdmin; computed: EventComputed }>(
        `/admin/events/${id}`,
      );
      setEvent(res.event);
      setComputed(res.computed ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load event.");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeStatus(status: EventStatus) {
    if (!event || status === event.status) return;
    setBusy(true);
    try {
      await apiPost(`/admin/events/${id}/status`, { status });
      toast.success(`Status changed to ${STATUS_LABEL[status]}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change status.");
    } finally {
      setBusy(false);
    }
  }

  async function changeVisibility(visibility: EventVisibility) {
    if (!event || visibility === event.visibility) return;
    setBusy(true);
    try {
      await apiPost(`/admin/events/${id}/visibility`, { visibility });
      toast.success(`Visibility changed to ${visibility}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change visibility.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!event) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const cap = computed?.capacity;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/events">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{event.title}</h1>
            <p className="text-xs text-muted-foreground">/{event.publicSlug}</p>
          </div>
          <EventStatusBadge status={event.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/edit`}>
              <Pencil className="size-4" />
              Edit
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/form`}>
              <FileText className="size-4" />
              Form
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/registrations`}>
              <Users className="size-4" />
              Registrations
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/events/${id}/export`}>
              <Download className="size-4" />
              Export
            </Link>
          </Button>
        </div>
      </div>

      {/* Status + visibility controls */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={event.status}
              onValueChange={(v) => changeStatus(v as EventStatus)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventStatusEnum.options.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s as EventStatus]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Visibility</CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={event.visibility}
              onValueChange={(v) => changeVisibility(v as EventVisibility)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventVisibilityEnum.options.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      {/* Count tiles. Per-status counts come from the row when present; else "—". */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Registered" value={event.registeredCount} />
        <Stat label="Checked in" value={event.checkedInCount} />
        <Stat label="Waitlisted" value={event.waitlistedCount} />
        <Stat label="Cancelled" value={event.cancelledCount} />
      </div>

      {/* Capacity + window status (from computed). */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Capacity</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {cap?.enabled ? (
              <>
                <span className="text-2xl font-semibold">{cap.used}</span>
                <span className="text-muted-foreground"> / {cap.limit ?? "∞"}</span>
                {cap.full ? (
                  <Badge className="ml-2 border-transparent bg-red-100 text-red-800">Full</Badge>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">No limit</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Registration window</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <WindowBadge open={computed?.registrationOpen} />
            <p className="text-xs text-muted-foreground">
              {formatBangkok(event.registrationOpenAt) || "—"} →{" "}
              {formatBangkok(event.registrationCloseAt) || "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Check-in window</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <WindowBadge open={computed?.checkinOpen} />
            <p className="text-xs text-muted-foreground">
              {formatBangkok(event.checkinOpenAt) || "—"} →{" "}
              {formatBangkok(event.checkinCloseAt) || "—"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <span className="text-2xl font-semibold">{value ?? "—"}</span>
      </CardContent>
    </Card>
  );
}

function WindowBadge({ open }: { open: boolean | undefined }) {
  if (open === undefined) return <Badge variant="outline">Unknown</Badge>;
  return open ? (
    <Badge className="border-transparent bg-green-100 text-green-800">Open</Badge>
  ) : (
    <Badge className="border-transparent bg-slate-200 text-slate-700">Closed</Badge>
  );
}
