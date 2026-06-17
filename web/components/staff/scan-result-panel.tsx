"use client";

// Renders the most recent scan outcome. Every ScanResultCode (+ network_error) has an explicit treatment.
// SAFETY: only `checked_in_success` is a success (green). Everything else is a denial/error — never green.
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  WifiOff,
  Clock,
  RotateCcw,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBangkok } from "@/lib/time";
import type { ScanResultCode } from "@/lib/types";
import type { ScanResponse } from "./types";

type Tone = "success" | "warn" | "deny" | "error";

// Per-code presentation. `manualHint` shows the "try manual search" nudge for invalid/revoked tokens.
const PRESENTATION: Record<
  ScanResultCode,
  { tone: Tone; title: string; hint: string; manualHint?: boolean }
> = {
  checked_in_success: { tone: "success", title: "เช็คอินแล้ว", hint: "ผู้เข้าร่วมได้เช็คอินเรียบร้อยแล้ว" },
  already_checked_in: {
    tone: "warn",
    title: "เช็คอินไปแล้ว",
    hint: "ผู้เข้าร่วมรายนี้เช็คอินไปแล้ว",
  },
  wrong_event: {
    tone: "deny",
    title: "ผิดกิจกรรม",
    hint: "บัตรนี้เป็นของกิจกรรมอื่น",
  },
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
  checkin_not_open: {
    tone: "warn",
    title: "ยังไม่เปิดเช็คอิน",
    hint: "ยังไม่ถึงช่วงเวลาเช็คอิน",
  },
  checkin_closed: {
    tone: "warn",
    title: "ปิดเช็คอินแล้ว",
    hint: "ช่วงเวลาเช็คอินสิ้นสุดแล้ว",
  },
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
  // network_error is UI-only: thrown ApiError / non-2xx / offline. NEVER a success.
  network_error: {
    tone: "error",
    title: "เครือข่ายผิดพลาด",
    hint: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ ผู้เข้าร่วมยังไม่ถูกเช็คอิน กรุณาลองใหม่",
  },
};

const TONE_STYLE: Record<Tone, string> = {
  success: "border-green-300 bg-green-50 text-green-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
  deny: "border-red-300 bg-red-50 text-red-900",
  error: "border-orange-400 bg-orange-50 text-orange-900",
};

function ToneIcon({ tone }: { tone: Tone }) {
  const cls = "size-7 shrink-0";
  if (tone === "success") return <CheckCircle2 className={cls} />;
  if (tone === "warn") return <Clock className={cls} />;
  if (tone === "error") return <WifiOff className={cls} />;
  return <XCircle className={cls} />;
}

export function ScanResultPanel({
  result,
  onRetry,
}: {
  result: ScanResponse | null;
  onRetry?: () => void;
}) {
  if (!result) {
    return (
      <Card className="flex min-h-[7rem] items-center justify-center p-6 text-center text-sm text-muted-foreground">
        สแกนคิวอาร์โค้ดหรือค้นหาด้วยตนเองเพื่อเริ่มต้น
      </Card>
    );
  }

  const p = PRESENTATION[result.result];
  const showSuccessDetails = result.result === "checked_in_success";
  const showAlreadyDetails = result.result === "already_checked_in";

  return (
    <Card className={cn("border-2 p-5", TONE_STYLE[p.tone])} aria-live="assertive">
      <div className="flex items-start gap-3">
        <ToneIcon tone={p.tone} />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold leading-tight">{p.title}</p>
          <p className="mt-0.5 text-sm opacity-90">{p.hint}</p>

          {/* Success detail (best-effort: backend may omit name/student_id/time). */}
          {showSuccessDetails && (result.fullName || result.studentId || result.checkedInAt) && (
            <dl className="mt-3 space-y-0.5 text-sm">
              {result.fullName && <DetailRow label="ชื่อ" value={result.fullName} />}
              {result.studentId && <DetailRow label="รหัสนักศึกษา" value={result.studentId} />}
              {result.checkedInAt && (
                <DetailRow label="เวลา" value={formatBangkok(result.checkedInAt)} />
              )}
            </dl>
          )}

          {/* Already-checked-in: show original time + who, if provided. */}
          {showAlreadyDetails && (result.originalCheckedInAt || result.checkedInBy) && (
            <dl className="mt-3 space-y-0.5 text-sm">
              {result.originalCheckedInAt && (
                <DetailRow label="เช็คอินเมื่อ" value={formatBangkok(result.originalCheckedInAt)} />
              )}
              {result.checkedInBy && <DetailRow label="โดย" value={result.checkedInBy} />}
            </dl>
          )}

          {p.manualHint && (
            <p className="mt-2 flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="size-4" /> ใช้การค้นหาด้วยตนเองด้านล่างเพื่อตรวจสอบ
            </p>
          )}

          {result.result === "network_error" && onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 bg-white"
              onClick={onRetry}
            >
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
