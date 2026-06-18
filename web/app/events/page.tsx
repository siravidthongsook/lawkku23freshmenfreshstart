"use client";

// Public event list: published+listed (and cancelled+listed w/ badge). Hides draft/unlisted/archived.
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventPublic } from "@/lib/types";
import { PublicShell } from "@/components/public/public-shell";
import { EventCard } from "@/components/public/event-card";
import { isPubliclyListed } from "@/components/public/event-helpers";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Sort options for the public list. Default = soonest upcoming first.
type SortKey = "date_asc" | "date_desc" | "title_asc" | "registered_desc";
const SORT_LABELS: Record<SortKey, string> = {
  date_asc: "วันที่: ใกล้ที่สุดก่อน",
  date_desc: "วันที่: ไกลที่สุดก่อน",
  title_asc: "ชื่อกิจกรรม (ก–ฮ / A–Z)",
  registered_desc: "ผู้ลงทะเบียนมากที่สุด",
};

// Null start dates sort last regardless of direction (treat as +Infinity).
function startMs(e: EventPublic): number {
  const t = e.eventStartAt ? Date.parse(e.eventStartAt) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date_asc");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Backend wraps the list in { events: [...] } — unwrap before filtering.
      const data = await apiGet<{ events: EventPublic[] }>("/events");
      const list = Array.isArray(data?.events) ? data.events : [];
      // Defensive: backend should already filter, but enforce public-visibility rules client-side too.
      setEvents(list.filter(isPubliclyListed));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Search + sort run client-side over the already-fetched list (small dataset, no extra API).
  const visibleEvents = useMemo(() => {
    if (!events) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? events.filter((e) =>
          [e.title, e.description, e.location]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(q)),
        )
      : events;
    // Copy before sort — never mutate the source array in place.
    const sorted = [...filtered];
    switch (sort) {
      case "date_desc":
        sorted.sort((a, b) => startMs(b) - startMs(a));
        break;
      case "title_asc":
        sorted.sort((a, b) => a.title.localeCompare(b.title, "th"));
        break;
      case "registered_desc":
        sorted.sort((a, b) => b.registeredCount - a.registeredCount);
        break;
      case "date_asc":
      default:
        sorted.sort((a, b) => startMs(a) - startMs(b));
        break;
    }
    return sorted;
  }, [events, query, sort]);

  return (
    <PublicShell>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">กิจกรรมที่กำลังจะมาถึง</h1>
        <p className="text-sm text-muted-foreground">เลือกชมและลงทะเบียนกิจกรรมนักศึกษา</p>
      </div>

      {/* Search + sort controls. Hidden while loading/errored — nothing to filter yet. */}
      {!loading && !error && events && events.length > 0 ? (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหากิจกรรม ชื่อ สถานที่ หรือรายละเอียด"
              className="pl-9"
              aria-label="ค้นหากิจกรรม"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-full sm:w-56" aria-label="เรียงลำดับ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

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
            ลองใหม่อีกครั้ง
          </Button>
        </div>
      ) : visibleEvents && visibleEvents.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visibleEvents.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      ) : events && events.length > 0 ? (
        // List has events but the search query matched none.
        <div className="rounded-lg border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">ไม่พบกิจกรรมที่ตรงกับ “{query.trim()}”</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setQuery("")}>
            ล้างการค้นหา
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">ขณะนี้ยังไม่มีกิจกรรมที่เปิดรับ กรุณากลับมาตรวจสอบอีกครั้งเร็ว ๆ นี้</p>
        </div>
      )}
    </PublicShell>
  );
}
