"use client";

// Recent scans strip (last few outcomes). Safety net for a fast one-by-one gate: even after the big
// result card advances to the next person, staff can glance here to confirm THIS person registered.
// In-memory only (resets on reload). No PII beyond name + student_id (scanner-minimal).
import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ScanResultCode } from "@/lib/types";
import type { RecentScan } from "./types";

// Compact per-code tone for the strip dot/icon. Only success is green; already-in is amber; rest red.
function codeTone(code: ScanResultCode): "ok" | "warn" | "bad" {
  if (code === "checked_in_success") return "ok";
  if (code === "already_checked_in") return "warn";
  return "bad";
}

function RowIcon({ code }: { code: ScanResultCode }) {
  const tone = codeTone(code);
  const cls = "size-4 shrink-0";
  if (tone === "ok") return <CheckCircle2 className={cn(cls, "text-green-600")} />;
  if (tone === "warn") return <Clock className={cn(cls, "text-amber-600")} />;
  return <XCircle className={cn(cls, "text-red-600")} />;
}

export function RecentScans({ items }: { items: RecentScan[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">สแกนล่าสุด</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.seq} className="flex items-center gap-2 text-sm">
            <RowIcon code={it.code} />
            <span className="min-w-0 flex-1 truncate">
              {it.fullName || it.studentId || "ไม่ทราบชื่อ"}
              {it.fullName && it.studentId ? (
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">{it.studentId}</span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{it.at}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
