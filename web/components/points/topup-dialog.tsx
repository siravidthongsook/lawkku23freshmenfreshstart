"use client";

// Topup dialog (plan §14): preset amount chips (5/10/25/50/100/250/500) + custom, with a MANDATORY
// reason (audited). Used by the staff-budget overview (single + bulk) and the per-staff detail page.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { reasonSchema } from "@/lib/schemas";
import { cn } from "@/lib/utils";

// Boss-designed preset amounts.
const PRESETS = [5, 10, 25, 50, 100, 250, 500];

export function TopupDialog({
  open,
  onOpenChange,
  title,
  description = "เลือกจำนวนแต้มที่จะเติม แล้วระบุเหตุผล (บันทึกไว้ในบันทึกการตรวจสอบ)",
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  pending?: boolean;
  onConfirm: (amount: number, reason: string) => void;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");

  // Reset fields each time the dialog opens.
  useEffect(() => {
    if (open) {
      setAmount(null);
      setCustom("");
      setReason("");
    }
  }, [open]);

  // Effective amount: a chip selection OR a parsed custom value (>0).
  const customNum = Number(custom);
  const effective = amount ?? (custom.trim() && customNum > 0 ? customNum : null);
  const validReason = reasonSchema.safeParse({ reason }).success;
  const canConfirm = effective != null && effective > 0 && validReason && !pending;

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>จำนวนแต้ม</Label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setAmount(p);
                    setCustom("");
                  }}
                  className={cn(
                    "h-10 min-w-14 rounded-md border px-3 text-sm font-medium tabular-nums",
                    amount === p
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  +{p}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-amount">หรือกำหนดเอง</Label>
            <Input
              id="custom-amount"
              type="number"
              inputMode="numeric"
              min={1}
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setAmount(null);
              }}
              placeholder="จำนวนแต้ม"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="topup-reason">เหตุผล (จำเป็น)</Label>
            <Textarea
              id="topup-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="เหตุใดจึงเติมงบ? บันทึกไว้ในบันทึกการตรวจสอบ"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            ยกเลิก
          </Button>
          <Button
            onClick={() => effective != null && onConfirm(effective, reason.trim())}
            disabled={!canConfirm}
          >
            {pending ? "กำลังดำเนินการ…" : effective ? `เติม +${effective}` : "เติมงบ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
