"use client";

// Check-in Staff landing: all check-in-capable events (global). Links each to its scanner.
import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, MapPin, ScanLine } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBangkok } from "@/lib/time";
import type { StaffEventListItem, StaffEventListResponse } from "@/components/staff/types";

const STAFF_ROLES = ["checkin_staff", "admin"] as const;

function CheckinWindow({ e }: { e: StaffEventListItem }) {
  const open = formatBangkok(e.checkinOpenAt);
  const close = formatBangkok(e.checkinCloseAt);
  if (!open && !close) return <span className="text-muted-foreground">ยังไม่ได้กำหนดช่วงเวลา</span>;
  return (
    <span>
      {open || "—"} → {close || "—"}
    </span>
  );
}

function EventsList() {
  const [events, setEvents] = useState<StaffEventListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiGet<StaffEventListResponse>("/staff/events");
        if (alive) setEvents(res.events ?? []);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
        setEvents([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (events === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">{error}</Card>
    );
  }

  if (events.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        ขณะนี้ไม่มีกิจกรรมที่เปิดให้เช็คอิน
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {events.map((e) => (
        <Card key={e.id} className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-base leading-snug">{e.title}</CardTitle>
              <Badge
                className={
                  e.checkinOpen
                    ? "bg-green-100 text-green-800 border-transparent"
                    : "bg-slate-200 text-slate-700 border-transparent"
                }
              >
                {e.checkinOpen ? "เปิด" : "ปิด"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3 pt-0 text-sm">
            <div className="space-y-1 text-muted-foreground">
              {e.location && (
                <p className="flex items-center gap-1.5">
                  <MapPin className="size-4 shrink-0" /> {e.location}
                </p>
              )}
              <p className="flex items-center gap-1.5">
                <CalendarClock className="size-4 shrink-0" /> <CheckinWindow e={e} />
              </p>
            </div>

            {/* Counts only render when the backend provides them. */}
            {(e.checkedInCount != null || e.registeredCount != null) && (
              <div className="flex gap-4 text-sm">
                <span>
                  <span className="font-semibold">{e.checkedInCount ?? 0}</span>
                  <span className="text-muted-foreground"> เช็คอินแล้ว</span>
                </span>
                <span>
                  <span className="font-semibold">{e.registeredCount ?? 0}</span>
                  <span className="text-muted-foreground"> ลงทะเบียนแล้ว</span>
                </span>
              </div>
            )}

            <Button asChild className="mt-auto h-11 w-full text-base">
              <Link href={`/staff/events/${e.id}/checkin`}>
                <ScanLine className="size-5" /> เปิดเครื่องสแกน
              </Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function StaffEventsPage() {
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <div className="space-y-4">
          <h1 className="text-xl font-semibold">เช็คอิน</h1>
          <EventsList />
        </div>
      </AppShell>
    </RequireRole>
  );
}
