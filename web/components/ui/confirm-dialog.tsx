"use client";

// Generic confirm dialog WITHOUT a reason field (use reason-dialog.tsx when a reason is mandatory).
// For destructive/sensitive confirms (publish, disable, delete field). onConfirm may be async — the
// confirm button shows a pending state and the dialog stays open until it resolves, then closes on success.
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

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "ยืนยัน",
  cancelLabel = "ยกเลิก",
  variant = "default",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  // May be sync or async; while it runs we show a pending state and block double-clicks.
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    try {
      setPending(true);
      await onConfirm();
      onOpenChange(false); // close on success; on throw we keep the dialog open so the user can retry
    } finally {
      setPending(false);
    }
  }

  // Ignore close attempts while the action is in flight.
  function handleOpenChange(next: boolean) {
    if (pending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "กำลังดำเนินการ…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
