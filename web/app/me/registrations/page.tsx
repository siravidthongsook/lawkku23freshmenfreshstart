"use client";

// /me/registrations — student's own registrations (incl. cancelled/archived if previously registered).
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, CalendarX } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { formatBangkok } from "@/lib/time";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { RegistrationStatusBadge } from "@/components/badges";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { regStatusLabel } from "@/lib/labels";
import type { RegistrationStatus } from "@/lib/types";
import type { MyRegistrationsResponse, StudentRegistration } from "@/components/student/types";

// Filter options: "all" + each registration status. Sort: by event date, soonest first by default.
type StatusFilter = "all" | RegistrationStatus;
const STATUS_FILTERS: StatusFilter[] = ["all", "registered", "checked_in", "waitlisted", "cancelled"];
type SortKey = "date_asc" | "date_desc";

// Stable timestamp for sorting: event start when known, else registration time; nulls sort last.
function rowMs(reg: StudentRegistration): number {
  const t = reg.eventStartAt ?? reg.registeredAt;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <CalendarX className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">ยังไม่มีการลงทะเบียน</p>
          <p className="text-sm text-muted-foreground">
            เมื่อคุณลงทะเบียนกิจกรรม รายการจะแสดงที่นี่
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/events">ดูกิจกรรม</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// One registration row. Title falls back to a generic label + short id so rows stay distinguishable
// even when the backend omits event-title enrichment (otherwise every row reads identically).
function RegistrationRow({ reg }: { reg: StudentRegistration }) {
  const title = reg.eventTitle ?? `การลงทะเบียนกิจกรรม #${reg.id.slice(0, 8)}`;
  const when = reg.eventStartAt ? formatBangkok(reg.eventStartAt) : null;

  return (
    <Link href={`/me/registrations/${reg.id}`} className="block">
      <Card className="transition-colors hover:bg-accent/50">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{title}</p>
              <RegistrationStatusBadge status={reg.status} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {when && <span>กิจกรรม: {when}</span>}
              {reg.checkedInAt && <span>เช็คอินแล้ว: {formatBangkok(reg.checkedInAt)}</span>}
              {reg.waitlistedAt && reg.status === "waitlisted" && (
                <span>รายชื่อสำรอง: {formatBangkok(reg.waitlistedAt)}</span>
              )}
              {reg.cancelledAt && <span>ยกเลิกแล้ว: {formatBangkok(reg.cancelledAt)}</span>}
              {!when && reg.registeredAt && <span>ลงทะเบียนเมื่อ: {formatBangkok(reg.registeredAt)}</span>}
            </div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

function MyRegistrationsInner() {
  const [regs, setRegs] = useState<StudentRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("date_asc");
  const [reloadKey, setReloadKey] = useState(0); // bump to retry the fetch

  useEffect(() => {
    let active = true;
    setError(null);
    setRegs(null);
    apiGet<MyRegistrationsResponse>("/me/registrations")
      .then((res) => {
        if (active) setRegs(res.registrations ?? []);
      })
      .catch((e) => {
        if (active) setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการลงทะเบียนได้");
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Filter by status then sort by date — client-side over the small per-student list.
  const visible = useMemo(() => {
    if (!regs) return null;
    const filtered = statusFilter === "all" ? regs : regs.filter((r) => r.status === statusFilter);
    return [...filtered].sort((a, b) =>
      sort === "date_desc" ? rowMs(b) - rowMs(a) : rowMs(a) - rowMs(b),
    );
  }, [regs, statusFilter, sort]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">กิจกรรมของฉัน</h1>

      {/* Sort + status filter — only meaningful once we have more than a couple of rows. */}
      {regs && regs.length > 1 ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-full sm:w-52" aria-label="กรองตามสถานะ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "ทุกสถานะ" : regStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-full sm:w-52" aria-label="เรียงลำดับ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date_asc">วันที่: ใกล้ที่สุดก่อน</SelectItem>
              <SelectItem value="date_desc">วันที่: ไกลที่สุดก่อน</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : regs === null ? (
        <Loading />
      ) : regs.length === 0 ? (
        <EmptyState />
      ) : visible && visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ไม่พบการลงทะเบียนที่ตรงกับตัวกรอง
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible!.map((r) => (
            <RegistrationRow key={r.id} reg={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function MyRegistrationsPage() {
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <MyRegistrationsInner />
      </AppShell>
    </RequireRole>
  );
}
