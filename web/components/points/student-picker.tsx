"use client";

// Searchable STUDENT picker for manual point grants (plan §4.6). Staff + admin: queries the
// staff-accessible endpoint (GET /points/student-search?q=) — debounced — and emits the chosen
// student. Not event-scoped (manual grant is app-wide), unlike admin-tools/user-picker.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { searchStudents } from "@/lib/points-api";
import type { StudentSearchResult } from "@/lib/points-types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function StudentPicker({
  value,
  onChange,
}: {
  value: string; // selected student uuid ("" = none)
  onChange: (userId: string, student: StudentSearchResult | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StudentSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StudentSearchResult | null>(null);

  const search = useCallback(async (q: string) => {
    // Backend requires q >= 2 chars; skip shorter queries to avoid a guaranteed 400.
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await searchStudents(q.trim());
      setResults(res.students ?? []);
    } catch (e) {
      void (e instanceof ApiError);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const t = setTimeout(() => void search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  function label(s: StudentSearchResult): string {
    const id = s.studentId ?? s.id;
    const nick = s.nickname ? ` (${s.nickname})` : "";
    return `${s.fullName}${nick} · ${id}`;
  }

  function select(s: StudentSearchResult) {
    onChange(s.id, s);
    setSelected(s);
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
        <Button variant="ghost" size="icon" className="size-6" onClick={clear} aria-label="ล้างนักศึกษาที่เลือก">
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
          placeholder="ค้นหานักศึกษา (รหัส ชื่อ หรือชื่อเล่น)"
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
          {results.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => select(s)}
              >
                <span className="font-medium">{s.fullName}</span>
                {s.nickname ? <span className="ml-1 text-muted-foreground">({s.nickname})</span> : null}
                <span className="ml-2 text-muted-foreground">{s.studentId ?? s.id}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : open && query.trim().length >= 2 && !searching ? (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
          ไม่พบนักศึกษาที่ตรงกัน
        </ul>
      ) : null}
    </div>
  );
}
