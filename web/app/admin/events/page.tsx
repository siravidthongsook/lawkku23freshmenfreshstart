"use client";

// Admin event list — ALL events incl. draft/archived. GET /admin/events.
// Server-driven: text search (q), status filter, and limit/offset pagination + per-row
// server-computed effective state + counts (no client clock / no N+1 recompute).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventAdmin, EventStatus, EventVisibility } from "@/lib/types";
import { eventStateLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EventStatusBadge } from "@/components/badges";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

// Tone for the server-computed effective-state badge (label comes from eventStateLabel).
const STATE_TONE: Record<string, string> = {
  open: "bg-green-100 text-green-800",
  full: "bg-red-100 text-red-800",
  not_open: "bg-amber-100 text-amber-800",
  closed_mode: "bg-amber-100 text-amber-800",
};

// Status filter options (incl. "all"). Mirrors event_status enum + a catch-all.
const STATUS_FILTER: { value: string; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "draft", label: "ฉบับร่าง" },
  { value: "published", label: "เผยแพร่แล้ว" },
  { value: "cancelled", label: "ยกเลิกแล้ว" },
  { value: "archived", label: "เก็บถาวรแล้ว" },
];

// Sort options. Default = newest event date first (matches public page's date sort, server-side).
type SortKey = "date_desc" | "date_asc" | "title_asc" | "created_desc";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "date_desc", label: "วันที่จัดกิจกรรม: ใหม่สุดไปเก่าสุด" },
  { value: "date_asc", label: "วันที่จัดกิจกรรม: เก่าสุดไปใหม่สุด" },
  { value: "title_asc", label: "ชื่อกิจกรรม (ก–ฮ / A–Z)" },
  { value: "created_desc", label: "เพิ่มล่าสุด" },
];

const PAGE_SIZE = 50;

// Admin row now also carries the server-computed effectiveState (events service).
type AdminEventRow = EventAdmin & { effectiveState?: string };

export default function AdminEventsPage() {
  const [events, setEvents] = useState<AdminEventRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false); // inline spinner on filter/search changes

  // Filters.
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [offset, setOffset] = useState(0);

  // Debounce the text input so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page whenever the filters change.
  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch, status, sort]);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (debouncedSearch) qs.set("q", debouncedSearch);
    if (status !== "all") qs.set("status", status);
    qs.set("sort", sort);
    qs.set("limit", String(PAGE_SIZE));
    qs.set("offset", String(offset));

    setReloading(true);
    setError(null);
    try {
      const res = await apiGet<{ events: AdminEventRow[]; total: number }>(
        `/admin/events?${qs.toString()}`,
      );
      setEvents(res.events ?? []);
      setTotal(res.total ?? res.events?.length ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
      setEvents([]); // keep rendering scaffolding, but the error suppresses the empty-state CTA
    } finally {
      setReloading(false);
    }
  }, [debouncedSearch, status, sort, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Distinguish "no events at all" (fresh system) from "no match for current filters".
  const hasActiveFilter = debouncedSearch !== "" || status !== "all";

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

      {/* Search + status filter bar. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Input
            placeholder="ค้นหาด้วยชื่อหรือ slug"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {reloading ? (
            <Loader2 className="absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-full sm:w-64" aria-label="เรียงลำดับ">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : events === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          {hasActiveFilter
            ? "ไม่พบกิจกรรมที่ตรงกับตัวกรอง"
            : "ยังไม่มีกิจกรรม สร้างกิจกรรมแรกของคุณ"}
        </div>
      ) : (
        <>
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
                    {/* Effective-state from the server. Only shown for published events — for
                        draft/cancelled/archived the status badge already says it (avoids the
                        duplicate "ฉบับร่าง" badge in both columns). */}
                    <TableCell>
                      {ev.status === "published" && ev.effectiveState ? (
                        <Badge
                          className={cn(
                            "border-transparent",
                            STATE_TONE[ev.effectiveState] ?? "bg-slate-200 text-slate-700",
                          )}
                        >
                          {eventStateLabel(ev.effectiveState)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {ev.visibility ? VISIBILITY_LABEL[ev.visibility] : "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{ev.registeredCount ?? "—"}</TableCell>
                    <TableCell className="text-right">{ev.checkedInCount ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBangkok(ev.eventStartAt) || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Quick actions: jump straight to overview (status/publish lives there) or edit. */}
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/events/${ev.id}`}>ดู</Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/events/${ev.id}/edit`}>แก้ไข</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination — backend returns total so Next/Prev are exact. */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              กำลังแสดง {offset + 1}–{offset + events.length} จาก {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || reloading}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                ก่อนหน้า
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + events.length >= total || reloading}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                ถัดไป
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
