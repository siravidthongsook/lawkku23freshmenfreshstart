"use client";

// Edit event. Loads the full admin row (GET /admin/events/:id), then PATCHes.
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, FileText } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventAdmin } from "@/lib/types";
import { EventForm } from "@/components/admin-events/event-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<EventAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinguish "not found" (404) from generic load errors so we can show a friendly state.
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    // Detail returns { event, computed }; we only need the event row for the form.
    apiGet<{ event: EventAdmin }>(`/admin/events/${id}`)
      .then((res) => active && setEvent(res.event))
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-20 text-center">
        <p className="text-lg font-medium">ไม่พบกิจกรรม</p>
        <p className="text-sm text-muted-foreground">กิจกรรมนี้อาจถูกลบหรือลิงก์ไม่ถูกต้อง</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/events">
            <ArrowLeft className="size-4" />
            กลับไปที่รายการกิจกรรม
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb trail: Events › title › แก้ไข */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/events" className="hover:underline">
          กิจกรรม
        </Link>
        <ChevronRight className="size-3" />
        <Link href={`/admin/events/${id}`} className="max-w-[16rem] truncate hover:underline">
          {event?.title ?? "กิจกรรม"}
        </Link>
        <ChevronRight className="size-3" />
        <span>แก้ไข</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/events/${id}`}>
              <ArrowLeft className="size-4" />
              ย้อนกลับ
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">แก้ไขกิจกรรม</h1>
        </div>
        {/* Cross-link to the form builder. */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/events/${id}/form`}>
            <FileText className="size-4" />
            แก้ไขฟอร์ม
          </Link>
        </Button>
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
