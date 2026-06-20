"use client";

// Check-in Staff landing: all check-in-capable events (global). Links each to its scanner.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, MapPin, ScanLine, RefreshCw } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
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
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiGet<StaffEventListResponse>("/staff/events");
      // Sort check-in-open events first so staff don't hunt for the active one (:74).
      const sorted = [...(res.events ?? [])].sort(
        (a, b) => Number(b.checkinOpen) - Number(a.checkinOpen),
      );
      setEvents(sorted);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Body varies by state; header (title + refresh) stays on one row above it at every width.
  let body: ReactNode;
  if (events === null && !error) {
    body = (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  } else if (error) {
    // Retry on error — flaky venue wifi shouldn't strand staff on a dead screen (:60).
    body = <ErrorState message={error} onRetry={load} />;
  } else if (!events || events.length === 0) {
    body = (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        ขณะนี้ไม่มีกิจกรรมที่เปิดให้เช็คอิน
      </Card>
    );
  } else {
    body = (
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

            {/* Backend always sends counts now (0 when none) — render only when present so a real 0 shows
                as "0" but a missing field (older backend) stays hidden rather than a misleading "0" (:105). */}
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

  // Header: title + refresh stay on ONE row at every width (mobile incl.) — refresh only once a list loads.
  const showRefresh = !!events && events.length > 0 && !error;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">เช็คอิน</h1>
        {showRefresh && (
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            รีเฟรช
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}

export default function StaffEventsPage() {
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <EventsList />
      </AppShell>
    </RequireRole>
  );
}
