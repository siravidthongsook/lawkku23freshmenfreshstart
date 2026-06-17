"use client";

// One-time temp-password reveal. Per CLAUDE.md temp passwords are shown ONCE and must NOT be
// persisted beyond this dialog — the parent clears its state on close. Includes a copy button +
// a clear "won't be shown again" warning.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function TempPasswordDialog({
  open,
  onClose,
  password,
  email,
}: {
  open: boolean;
  onClose: () => void;
  password: string | null;
  email?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>รหัสผ่านชั่วคราว</DialogTitle>
          <DialogDescription>
            {email ? <>สำหรับ {email} </> : null}
            รหัสผ่านนี้จะแสดงเพียงครั้งเดียว คัดลอกตอนนี้ — จะไม่แสดงอีก ส่งให้ผู้ใช้
            อย่างปลอดภัย ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
          <code className="flex-1 break-all font-mono text-sm">{password}</code>
          <Button variant="outline" size="icon" onClick={copy} aria-label="คัดลอกรหัสผ่าน">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>เสร็จสิ้น</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
