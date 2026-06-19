"use client";

// Budget gauge — prominent balance display for staff/admin budget pages (plan §14).
// Shows the current point budget with a low-budget warning tint. Pure presentation; no fetching.
import { Coins, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// `low` (default budget < 10) tints amber so event-day "needs topup" stands out.
export function BudgetGauge({ budget, low }: { budget: number; low?: boolean }) {
  const isLow = low ?? budget < 10;
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-xl border p-5",
        isLow ? "border-amber-300 bg-amber-50" : "border-primary/20 bg-primary/5",
      )}
    >
      <span
        className={cn(
          "flex size-14 shrink-0 items-center justify-center rounded-full",
          isLow ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary",
        )}
      >
        <Coins className="size-7" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">งบแต้มคงเหลือ</p>
        <p className={cn("text-3xl font-bold tabular-nums", isLow && "text-amber-700")}>
          {budget}
        </p>
        {isLow ? (
          <p className="flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle className="size-3.5" /> งบใกล้หมด ควรเติม
          </p>
        ) : null}
      </div>
    </div>
  );
}
