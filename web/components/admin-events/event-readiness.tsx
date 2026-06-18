"use client";

// Effective-state ("สำหรับนักศึกษาตอนนี้") card for the admin event overview.
// Mirrors the real self-register rule from src/modules/events/service.ts:86-90:
//   status==='published' AND registrationMode==='public_self_register'
//   AND now within [open,close] AND not full.
// visibility (listed/unlisted) only affects discoverability once published.
import { Check, X, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EventAdmin } from "@/lib/types";

// Subset of the event detail computed block we rely on here.
export type EventComputed = {
  registrationOpen: boolean;
  checkinOpen: boolean;
  capacity: { enabled: boolean; limit: number | null; used: number; full: boolean };
};

type Props = {
  event: EventAdmin;
  computed: EventComputed | null;
  // null while loading; { hasForm, version } once the form fetch resolves.
  form: { hasForm: boolean; version: number | null } | null;
};

// One-sentence effective state for students, plus a tone for the headline badge.
function effectiveState(
  event: EventAdmin,
  computed: EventComputed | null,
): { text: string; tone: "open" | "closed" | "draft" | "gone" } {
  if (event.status === "draft") {
    return { text: "ฉบับร่าง — นักศึกษายังมองไม่เห็นกิจกรรมนี้", tone: "draft" };
  }
  if (event.status === "cancelled") {
    return { text: "ยกเลิกแล้ว — ไม่เปิดรับลงทะเบียน", tone: "gone" };
  }
  if (event.status === "archived") {
    return { text: "เก็บถาวรแล้ว — อ่านได้อย่างเดียว ไม่เปิดรับลงทะเบียน", tone: "gone" };
  }
  // published from here on
  if (computed?.registrationOpen) {
    return { text: "เปิดให้ลงทะเบียน", tone: "open" };
  }
  if (event.registrationMode === "closed") {
    return { text: "เผยแพร่แล้ว แต่ปิดรับลงทะเบียน", tone: "closed" };
  }
  return { text: "เผยแพร่แล้ว แต่ยังไม่เปิดรับลงทะเบียน", tone: "closed" };
}

// Single human reason why self-register is currently blocked (first failing precondition).
function closedReason(
  event: EventAdmin,
  computed: EventComputed | null,
  form: Props["form"],
): string | null {
  if (event.status !== "published") return null; // headline already explains non-published
  if (event.registrationMode !== "public_self_register") {
    const mode = event.registrationMode === "closed" ? "'ปิด'" : "'นำเข้าโดยผู้ดูแลเท่านั้น'";
    return `ปิดรับลงทะเบียนเพราะ: รูปแบบการลงทะเบียนเป็น ${mode}`;
  }
  if (computed?.capacity.full) return "ปิดรับลงทะเบียนเพราะ: ที่นั่งเต็มแล้ว";
  if (!computed?.registrationOpen) {
    return "ปิดรับลงทะเบียนเพราะ: ไม่อยู่ในช่วงเวลาลงทะเบียน";
  }
  if (form && !form.hasForm) return "ปิดรับลงทะเบียนเพราะ: ยังไม่ได้สร้างฟอร์มลงทะเบียน";
  return null;
}

const TONE_BADGE: Record<string, string> = {
  open: "bg-green-100 text-green-800 border-transparent",
  closed: "bg-amber-100 text-amber-800 border-transparent",
  draft: "bg-slate-200 text-slate-800 border-transparent",
  gone: "bg-red-100 text-red-800 border-transparent",
};
const TONE_LABEL: Record<string, string> = {
  open: "เปิดรับ",
  closed: "ปิดรับ",
  draft: "ฉบับร่าง",
  gone: "ไม่เปิดรับ",
};

export function EventReadiness({ event, computed, form }: Props) {
  const state = effectiveState(event, computed);
  const reason = closedReason(event, computed, form);

  // Precondition checklist — each derived from event + computed (+ form fetch).
  const checks: { label: string; ok: boolean | null }[] = [
    { label: "เผยแพร่แล้ว", ok: event.status === "published" },
    {
      label: "รูปแบบ = ลงทะเบียนเอง",
      ok: event.registrationMode === "public_self_register",
    },
    { label: "อยู่ในช่วงเวลาลงทะเบียน", ok: computed?.registrationOpen ?? null },
    { label: "ยังไม่เต็ม", ok: computed ? !computed.capacity.full : null },
    // form === null → still loading; show neutral state.
    { label: "มีฟอร์มแล้ว", ok: form ? form.hasForm : null },
  ];

  return (
    <Card className="border-l-4 border-l-primary">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">สำหรับนักศึกษาตอนนี้</CardTitle>
          <Badge className={cn(TONE_BADGE[state.tone])}>{TONE_LABEL[state.tone]}</Badge>
        </div>
        <p className="pt-1 text-base font-medium">{state.text}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {checks.map((chk) => (
            <li key={chk.label} className="flex items-center gap-2">
              {chk.ok === null ? (
                <span className="size-4 rounded-full border border-dashed border-muted-foreground/40" />
              ) : chk.ok ? (
                <Check className="size-4 text-green-600" />
              ) : (
                <X className="size-4 text-red-500" />
              )}
              <span className={cn(chk.ok === false && "text-muted-foreground")}>{chk.label}</span>
            </li>
          ))}
        </ul>

        {reason ? (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {reason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
