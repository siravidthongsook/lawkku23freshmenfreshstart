"use client";

// Searchable event picker → replaces raw-UUID text inputs for "target event" fields (import/export).
// Queries GET /admin/events?q=… (debounced); the caller gets back the chosen event id + title.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type EventRow = { id: string; title: string; status?: string };
type EventListResponse = { events: EventRow[] };

export function EventPicker({
  value,
  onChange,
  placeholder = "ค้นหากิจกรรมด้วยชื่อ",
}: {
  // Selected event id ("" when none) — kept controlled so the parent owns the payload value.
  value: string;
  onChange: (eventId: string, title: string | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EventRow[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await apiGet<EventListResponse>(`/admin/events?q=${encodeURIComponent(q.trim())}`);
      setResults(res.events ?? []);
    } catch (e) {
      // Search failures are non-fatal — just show no options (caller still sees the missing-event error on confirm).
      void (e instanceof ApiError);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // Debounce keystrokes.
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const t = setTimeout(() => void search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  function select(ev: EventRow) {
    onChange(ev.id, ev.title);
    setSelectedTitle(ev.title);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  function clear() {
    onChange("", null);
    setSelectedTitle(null);
    setQuery("");
    setResults([]);
  }

  // Selected state: show the chosen event as a chip with a clear button.
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
        <span className="flex-1 truncate">{selectedTitle ?? value}</span>
        <Button variant="ghost" size="icon" className="size-6" onClick={clear} aria-label="ล้างกิจกรรมที่เลือก">
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <Input
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        {searching ? (
          <Loader2 className="absolute right-2 top-2.5 size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      {open && results.length > 0 ? (
        <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-md">
          {results.map((ev) => (
            <li key={ev.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => select(ev)}
              >
                {ev.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
