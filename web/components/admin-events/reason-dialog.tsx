"use client";

// Reusable reason-prompt dialog for sensitive admin actions (cancel/promote/demote/QR/answers edit).
// Reason is MANDATORY: submit stays disabled until a non-empty reason is given (matches backend reasonSchema).
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { reasonSchema } from "@/lib/schemas";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";

export type ReasonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  // Called with the validated reason; should perform the mutation and may throw (caller toasts).
  onConfirm: (reason: string) => Promise<void>;
};

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "ยืนยัน",
  destructive = false,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // reasonSchema trims + requires min(1) — mirror that to gate the submit button.
  const reasonValid = reasonSchema.safeParse({ reason }).success;

  async function handleConfirm() {
    if (!reasonValid || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onOpenChange(false);
    } catch (err) {
      // Surface failure as toast + keep dialog open (don't bubble → no Next error overlay).
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถดำเนินการได้");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason(""); // reset on close
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">
            เหตุผล <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="จำเป็น — บันทึกไว้ในบันทึกการตรวจสอบ"
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            การกระทำนี้ถูกบันทึกไว้ในบันทึกการตรวจสอบและไม่สามารถยกเลิกได้หากไม่มีการกระทำอื่น
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            ยกเลิก
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={!reasonValid || submitting}
          >
            {submitting ? "กำลังดำเนินการ…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
