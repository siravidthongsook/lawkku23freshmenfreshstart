"use client";

// Admin event list — ALL events incl. draft/archived. GET /admin/events.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventAdmin } from "@/lib/types";
import { formatBangkok } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EventStatusBadge } from "@/components/badges";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function AdminEventsPage() {
  const [events, setEvents] = useState<EventAdmin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<{ events: EventAdmin[] }>("/admin/events")
      .then((res) => active && setEvents(res.events ?? []))
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
        setEvents([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">กิจกรรม</h1>
        <Button asChild>
          <Link href="/admin/events/new">
            <Plus className="size-4" />
            สร้างกิจกรรมใหม่
          </Link>
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {events === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          ยังไม่มีกิจกรรม สร้างกิจกรรมแรกของคุณ
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>หัวข้อ</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead>การมองเห็น</TableHead>
                <TableHead className="text-right">ลงทะเบียน</TableHead>
                <TableHead className="text-right">เช็คอินแล้ว</TableHead>
                <TableHead>วันที่จัดกิจกรรม</TableHead>
                <TableHead className="text-right">การกระทำ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((ev) => (
                <TableRow key={ev.id}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/events/${ev.id}`} className="hover:underline">
                      {ev.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">/{ev.publicSlug}</div>
                  </TableCell>
                  <TableCell>
                    <EventStatusBadge status={ev.status} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{ev.visibility ?? "—"}</Badge>
                  </TableCell>
                  {/* Counts may be absent until backend includes them — fall back to "—". */}
                  <TableCell className="text-right">{ev.registeredCount ?? "—"}</TableCell>
                  <TableCell className="text-right">{ev.checkedInCount ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatBangkok(ev.eventStartAt) || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/admin/events/${ev.id}/edit`}>แก้ไข</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
