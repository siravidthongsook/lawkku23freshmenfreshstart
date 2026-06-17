"use client";

// Reason-gated confirm dialog. Used by reset-password & change-role (reason MANDATORY per CLAUDE.md).
// Validates the reason with reasonSchema before allowing submit; disables the action button while pending.
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { reasonSchema } from "@/lib/schemas";

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  pending = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  // Called with the validated reason; parent performs the mutation.
  onConfirm: (reason: string) => void;
  // Extra controls rendered above the reason field (e.g. a role <Select>).
  children?: React.ReactNode;
}) {
  const [reason, setReason] = useState("");
  const valid = reasonSchema.safeParse({ reason }).success;

  function handleConfirm() {
    if (!valid) return;
    onConfirm(reason.trim());
  }

  // Reset the field whenever the dialog is closed so the next open starts clean.
  function handleOpenChange(next: boolean) {
    if (!next) setReason("");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-3">
          {children}
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason (required)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you doing this? Recorded in the audit log."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={!valid || pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
