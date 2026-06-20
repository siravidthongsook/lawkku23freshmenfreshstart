"use client";

// Renders the most recent scan outcome. Every ScanResultCode (+ network_error/processing) has an explicit
// treatment. SAFETY: only `checked_in_success` / `checked_out_success` are a success (green). Everything
// else is a denial/error/pending — never green. The card remounts per scan (key={result.seq}) so
// back-to-back outcomes visibly re-fire instead of looking like a stale previous result.
import { useEffect } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  WifiOff,
  Clock,
  CalendarClock,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBangkok } from "@/lib/time";
import { feedbackSuccess, feedbackWarn, feedbackDeny } from "./feedback";
import type { ScanResultCode } from "@/lib/types";
import type { DisplayScan } from "./types";

// `info` = window timing (not-open/closed). `pending` = awaiting server (no sound).
type Tone = "success" | "warn" | "info" | "deny" | "error" | "pending";

const PRESENTATION: Record<
  ScanResultCode,
  { tone: Tone; title: string; hint: string; manualHint?: boolean }
> = {
  checked_in_success: { tone: "success", title: "เช็คอินสำเร็จ", hint: "ผู้เข้าร่วมเช็คอินเรียบร้อยแล้ว" },
  already_checked_in: {
    tone: "warn",
    title: "เช็คอินไปแล้ว",
    hint: "ผู้เข้าร่วมรายนี้เช็คอินไปแล้ว",
  },
  // Scan-OUT outcomes (§4.2).
  checked_out_success: { tone: "success", title: "เช็คเอาท์สำเร็จ", hint: "ผู้เข้าร่วมเช็คเอาท์เรียบร้อยแล้ว" },
  already_checked_out: {
    tone: "warn",
    title: "เช็คเอาท์ไปแล้ว",
    hint: "ผู้เข้าร่วมรายนี้เช็คเอาท์ไปแล้ว",
  },
  not_checked_in: {
    tone: "deny",
    title: "ยังไม่ได้เช็คอิน",
    hint: "ต้องเช็คอินก่อนจึงจะเช็คเอาท์ได้",
  },
  scan_window_closed: { tone: "info", title: "นอกช่วงเวลาเช็คเอาท์", hint: "ยังไม่ถึงหรือหมดช่วงเวลาเช็คเอาท์แล้ว" },
  points_closed: { tone: "info", title: "ปิดรับแต้มแล้ว", hint: "เลยกำหนดเวลารับแต้มของกิจกรรมแล้ว" },
  checkout_disabled: { tone: "deny", title: "ไม่ได้เปิดเช็คเอาท์", hint: "กิจกรรมนี้ไม่ได้เปิดให้เช็คเอาท์" },
  wrong_event: { tone: "deny", title: "ผิดกิจกรรม", hint: "บัตรนี้เป็นของกิจกรรมอื่น" },
  registration_cancelled: {
    tone: "deny",
    title: "ยกเลิกการลงทะเบียนแล้ว",
    hint: "การลงทะเบียนนี้ถูกยกเลิก ไม่สามารถเช็คอินได้",
  },
  waitlisted_not_allowed: {
    tone: "deny",
    title: "รายชื่อสำรอง",
    hint: "ผู้ที่อยู่ในรายชื่อสำรองไม่สามารถเช็คอินได้",
  },
  checkin_not_open: { tone: "info", title: "ยังไม่เปิดเช็คอิน", hint: "ยังไม่ถึงช่วงเวลาเช็คอิน" },
  checkin_closed: { tone: "info", title: "ปิดเช็คอินแล้ว", hint: "ช่วงเวลาเช็คอินสิ้นสุดแล้ว" },
  event_not_published: {
    tone: "deny",
    title: "กิจกรรมยังไม่เผยแพร่",
    hint: "กิจกรรมนี้ยังไม่เปิดให้เช็คอิน",
  },
  event_cancelled: { tone: "deny", title: "ยกเลิกกิจกรรมแล้ว", hint: "กิจกรรมนี้ถูกยกเลิก" },
  qr_revoked: {
    tone: "deny",
    title: "คิวอาร์โค้ดถูกเพิกถอน",
    hint: "คิวอาร์โค้ดนี้ใช้ไม่ได้แล้ว ลองค้นหาด้วยตนเอง",
    manualHint: true,
  },
  qr_invalid: {
    tone: "deny",
    title: "คิวอาร์โค้ดไม่ถูกต้อง",
    hint: "ไม่รู้จักโค้ดนี้ ลองค้นหาด้วยตนเอง",
    manualHint: true,
  },
  // UI-only: thrown ApiError / non-2xx / offline. NEVER a success.
  network_error: {
    tone: "error",
    title: "เครือข่ายผิดพลาด",
    hint: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ ผู้เข้าร่วมยังไม่ถูกเช็คอิน กรุณาลองใหม่",
  },
  // UI-only: scan sent, awaiting server. Blanks the previous result so a stale green can't be misread.
  processing: { tone: "pending", title: "กำลังตรวจสอบ…", hint: "กำลังยืนยันกับเซิร์ฟเวอร์" },
};

const TONE_STYLE: Record<Tone, string> = {
  success: "border-green-400 bg-green-50 text-green-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
  info: "border-blue-300 bg-blue-50 text-blue-900",
  deny: "border-red-300 bg-red-50 text-red-900",
  error: "border-orange-400 bg-orange-50 text-orange-900",
  pending: "border-slate-300 bg-slate-50 text-slate-700",
};

function ToneIcon({ tone }: { tone: Tone }) {
  const cls = "size-8 shrink-0";
  if (tone === "success") return <CheckCircle2 className={cls} />;
  if (tone === "warn") return <Clock className={cls} />;
  if (tone === "info") return <CalendarClock className={cls} />;
  if (tone === "error") return <WifiOff className={cls} />;
  if (tone === "pending") return <Loader2 className={cn(cls, "animate-spin")} />;
  return <XCircle className={cls} />;
}

// Map a tone to audio+haptic. success=chirp, warn/info=soft double-beep, deny/error=buzzer, pending=silent.
function playFeedback(tone: Tone): void {
  if (tone === "pending") return; // no sound while waiting
  if (tone === "success") return feedbackSuccess();
  if (tone === "warn" || tone === "info") return feedbackWarn();
  return feedbackDeny();
}

export function ScanResultPanel({
  result,
  onRetry,
}: {
  result: DisplayScan | null;
  onRetry?: () => void;
}) {
  // Fire audio+haptic on every new scan. Keyed on seq so identical back-to-back outcomes still re-fire.
  useEffect(() => {
    if (!result) return;
    playFeedback(PRESENTATION[result.result].tone);
  }, [result?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result) {
    return (
      <Card className="flex min-h-[7rem] items-center justify-center p-6 text-center text-sm text-muted-foreground">
        สแกนคิวอาร์โค้ดหรือค้นหาด้วยตนเองเพื่อเริ่มต้น
      </Card>
    );
  }

  const p = PRESENTATION[result.result];
  const isSuccess = result.result === "checked_in_success" || result.result === "checked_out_success";
  const isAlready = result.result === "already_checked_in" || result.result === "already_checked_out";
  // Direction-agnostic confirmation time: check-in stamps checkedInAt, check-out stamps checkedOutAt.
  const successAt = result.checkedInAt ?? result.checkedOutAt ?? null;
  // Any reg-bearing outcome carries identity; show it so staff confirm WHO this scan was for.
  const hasIdentity = !!(result.fullName || result.studentId);

  return (
    // key={seq} remounts the card each scan → CSS pop animation replays → clearly a fresh hit.
    <Card
      key={result.seq}
      className={cn("animate-scan-pop border-2 p-5", TONE_STYLE[p.tone])}
      aria-live="assertive"
    >
      <div className="flex items-start gap-3">
        <ToneIcon tone={p.tone} />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold leading-tight">{p.title}</p>

          {/* Identity hero: on success the name/ID is the headline so staff glance-confirm the person. */}
          {hasIdentity ? (
            <div className={cn("mt-2", isSuccess && "rounded-md bg-white/60 px-3 py-2")}>
              {result.fullName && (
                <p className={cn("font-bold leading-tight", isSuccess ? "text-2xl" : "text-base")}>
                  {result.fullName}
                </p>
              )}
              {result.studentId && (
                <p className={cn("font-mono", isSuccess ? "text-base" : "text-sm opacity-80")}>
                  {result.studentId}
                </p>
              )}
            </div>
          ) : (
            <p className="mt-0.5 text-sm opacity-90">{p.hint}</p>
          )}

          {/* Success: confirmation time (check-in or check-out). */}
          {isSuccess && successAt && (
            <p className="mt-2 text-sm opacity-90">เวลา {formatBangkok(successAt)}</p>
          )}

          {/* Already-checked-in: original time + who, so staff can tell a duplicate from a fresh check-in. */}
          {result.result === "already_checked_in" && (result.originalCheckedInAt || result.checkedInBy) && (
            <dl className="mt-2 space-y-0.5 text-sm">
              {result.originalCheckedInAt && (
                <DetailRow label="เช็คอินเมื่อ" value={formatBangkok(result.originalCheckedInAt)} />
              )}
              {result.checkedInBy && <DetailRow label="โดย" value={result.checkedInBy} />}
            </dl>
          )}

          {/* Already-checked-out: when it happened, so staff can tell a duplicate from a fresh check-out. */}
          {result.result === "already_checked_out" && result.checkedOutAt && (
            <dl className="mt-2 space-y-0.5 text-sm">
              <DetailRow label="เช็คเอาท์เมื่อ" value={formatBangkok(result.checkedOutAt)} />
            </dl>
          )}

          {/* When identity is the hero, surface the hint as a thin secondary line for non-success outcomes. */}
          {hasIdentity && !isSuccess && <p className="mt-2 text-sm opacity-90">{p.hint}</p>}

          {p.manualHint && (
            <p className="mt-2 flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="size-4" /> ใช้การค้นหาด้วยตนเองด้านล่างเพื่อตรวจสอบ
            </p>
          )}

          {result.result === "network_error" && onRetry && (
            <Button variant="outline" size="sm" className="mt-3 bg-white" onClick={onRetry}>
              <RotateCcw className="size-4" /> ลองใหม่
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 opacity-70">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
