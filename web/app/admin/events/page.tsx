"use client";

// Admin event list — ALL events incl. draft/archived. GET /admin/events.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventAdmin, EventVisibility, RegistrationMode } from "@/lib/types";
import { formatBangkok } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

const VISIBILITY_LABEL: Record<EventVisibility, string> = {
  listed: "แสดงในรายการ",
  unlisted: "ผ่านลิงก์เท่านั้น",
};

// Lightweight derived effective-state for the list (no `computed` here — uses row fields only).
// Mirrors the self-register rule minus capacity/now precision: status + mode + window timestamps.
function effectiveState(ev: EventAdmin): { label: string; cls: string } {
  if (ev.status === "draft") return { label: "ฉบับร่าง", cls: "bg-slate-200 text-slate-700" };
  if (ev.status === "cancelled") return { label: "ยกเลิก", cls: "bg-red-100 text-red-800" };
  if (ev.status === "archived") return { label: "เก็บถาวร", cls: "bg-zinc-100 text-zinc-600" };
  // published
  const mode = ev.registrationMode as RegistrationMode;
  if (mode !== "public_self_register") return { label: "ปิดรับ", cls: "bg-amber-100 text-amber-800" };
  const now = Date.now();
  const opensOk = !ev.registrationOpenAt || new Date(ev.registrationOpenAt).getTime() <= now;
  const closesOk = !ev.registrationCloseAt || new Date(ev.registrationCloseAt).getTime() > now;
  return opensOk && closesOk
    ? { label: "เปิดรับ", cls: "bg-green-100 text-green-800" }
    : { label: "ปิดรับ", cls: "bg-amber-100 text-amber-800" };
}

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
                <TableHead>สำหรับนักศึกษา</TableHead>
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
                  {/* Derived effective-state (best-effort, row-only). */}
                  <TableCell>
                    {(() => {
                      const eff = effectiveState(ev);
                      return <Badge className={cn("border-transparent", eff.cls)}>{eff.label}</Badge>;
                    })()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {ev.visibility ? VISIBILITY_LABEL[ev.visibility] : "—"}
                    </Badge>
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
