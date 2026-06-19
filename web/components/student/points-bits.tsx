"use client";

// Shared presentation bits for the student points (wallet) feature: reason icon + signed-delta pill.
// Kept tiny + reuse-only so the wallet list, detail sheet, and scan-result panels look identical.
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  Gift,
  HandCoins,
  RotateCcw,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PointReason } from "@/lib/points-types";

const REASON_ICON: Record<PointReason, LucideIcon> = {
  checkin_in: ArrowDownToLine,
  checkin_out: ArrowUpFromLine,
  assessment_completed: ClipboardCheck,
  staff_grant_qr: Gift,
  manual_adjust: HandCoins,
  peer_connect: UserPlus,
  correction_add: Sparkles,
  correction_reverse: RotateCcw,
};

// Round icon badge for a ledger reason. Negative deltas tint red, positives the brand tint.
export function ReasonIcon({ reason, delta }: { reason: PointReason; delta: number }) {
  const Icon = REASON_ICON[reason] ?? Sparkles;
  const negative = delta < 0;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full",
        negative ? "bg-red-100 text-red-700" : "bg-primary/10 text-primary",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

// Signed points pill: +N green, −N red. Used in history rows + detail.
export function DeltaPill({ delta, className }: { delta: number; className?: string }) {
  const positive = delta >= 0;
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        positive ? "text-green-600" : "text-red-600",
        className,
      )}
    >
      {positive ? "+" : ""}
      {delta}
    </span>
  );
}
