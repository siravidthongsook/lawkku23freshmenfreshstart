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
  checked_in_success: { tone: "success", title: "Checked in", hint: "Attendee is now checked in." },
  already_checked_in: {
    tone: "warn",
    title: "Already checked in",
    hint: "This attendee was already checked in.",
  },
  wrong_event: {
    tone: "deny",
    title: "Wrong event",
    hint: "This ticket belongs to a different event.",
  },
  registration_cancelled: {
    tone: "deny",
    title: "Registration cancelled",
    hint: "This registration was cancelled — cannot check in.",
  },
  waitlisted_not_allowed: {
    tone: "deny",
    title: "Waitlisted",
    hint: "Waitlisted attendees cannot check in.",
  },
  checkin_not_open: {
    tone: "warn",
    title: "Check-in not open yet",
    hint: "The check-in window has not started.",
  },
  checkin_closed: {
    tone: "warn",
    title: "Check-in closed",
    hint: "The check-in window has ended.",
  },
  event_not_published: {
    tone: "deny",
    title: "Event not published",
    hint: "This event is not open for check-in.",
  },
  event_cancelled: { tone: "deny", title: "Event cancelled", hint: "This event was cancelled." },
  qr_revoked: {
    tone: "deny",
    title: "QR revoked",
    hint: "This QR code is no longer valid. Try manual search.",
    manualHint: true,
  },
  qr_invalid: {
    tone: "deny",
    title: "Invalid QR",
    hint: "This code is not recognised. Try manual search.",
    manualHint: true,
  },
  // network_error is UI-only: thrown ApiError / non-2xx / offline. NEVER a success.
  network_error: {
    tone: "error",
    title: "Network error",
    hint: "Could not reach the server. The attendee was NOT checked in — retry.",
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
        Scan a QR code or search manually to begin.
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
              {result.fullName && <DetailRow label="Name" value={result.fullName} />}
              {result.studentId && <DetailRow label="Student ID" value={result.studentId} />}
              {result.checkedInAt && (
                <DetailRow label="Time" value={formatBangkok(result.checkedInAt)} />
              )}
            </dl>
          )}

          {/* Already-checked-in: show original time + who, if provided. */}
          {showAlreadyDetails && (result.originalCheckedInAt || result.checkedInBy) && (
            <dl className="mt-3 space-y-0.5 text-sm">
              {result.originalCheckedInAt && (
                <DetailRow label="Checked in at" value={formatBangkok(result.originalCheckedInAt)} />
              )}
              {result.checkedInBy && <DetailRow label="By" value={result.checkedInBy} />}
            </dl>
          )}

          {p.manualHint && (
            <p className="mt-2 flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="size-4" /> Use manual search below to verify.
            </p>
          )}

          {result.result === "network_error" && onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 bg-white"
              onClick={onRetry}
            >
              <RotateCcw className="size-4" /> Retry
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
