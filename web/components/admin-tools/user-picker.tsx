"use client";

// Searchable user picker for manual registration → replaces the raw-UUID input.
// Queries GET /admin/events/:eventId/user-search?q=… (by student id / email / name, debounced).
// Backend already excludes users with a non-cancelled registration for this event.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { UserSearchRow } from "@/components/admin-tools/wire";

export function UserPicker({
  eventId,
  value,
  onChange,
}: {
  eventId: string;
  // Selected user id ("" when none) — controlled so the parent owns the payload value.
  value: string;
  onChange: (userId: string, user: UserSearchRow | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<UserSearchRow | null>(null);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const res = await apiGet<{ users: UserSearchRow[] }>(
          `/admin/events/${eventId}/user-search?q=${encodeURIComponent(q.trim())}`,
        );
        setResults(res.users ?? []);
      } catch (e) {
        void (e instanceof ApiError);
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [eventId],
  );

  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const t = setTimeout(() => void search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  function label(u: UserSearchRow): string {
    const id = u.studentId ?? u.email ?? u.id;
    return `${u.fullName ?? "(ไม่มีชื่อ)"} · ${id}`;
  }

  function select(u: UserSearchRow) {
    onChange(u.id, u);
    setSelected(u);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  function clear() {
    onChange("", null);
    setSelected(null);
    setQuery("");
    setResults([]);
  }

  if (value && selected) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
        <span className="flex-1 truncate">{label(selected)}</span>
        <Button variant="ghost" size="icon" className="size-6" onClick={clear} aria-label="ล้างผู้ใช้ที่เลือก">
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
          placeholder="ค้นหาด้วยรหัสนักศึกษา อีเมล หรือชื่อ"
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
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => select(u)}
              >
                <span className="font-medium">{u.fullName ?? "(ไม่มีชื่อ)"}</span>
                <span className="ml-2 text-muted-foreground">
                  {u.studentId ?? u.email ?? u.id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : open && query.trim() && !searching ? (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
          ไม่พบผู้ใช้ที่ตรงกัน (หรืออาจลงทะเบียนไว้แล้ว)
        </ul>
      ) : null}
    </div>
  );
}
