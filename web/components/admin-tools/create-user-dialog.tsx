"use client";

// Create-user form. Validates with createUserSchema (student_id required for students).
// Backend generates the temp password server-side; if the create response includes it we show it
// ONCE via TempPasswordDialog, otherwise we point the admin to the temp-password export page.
import { useState } from "react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { createUserSchema } from "@/lib/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TempPasswordDialog } from "@/components/admin-tools/temp-password-dialog";
import type { CreateUserResponse } from "@/components/admin-tools/wire";
import type { Role } from "@/lib/types";

const EMPTY = {
  email: "",
  student_id: "",
  role: "student" as Role,
  full_name: "",
  faculty: "",
  department: "",
  phone: "",
};

export function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ ...EMPTY });
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Temp-pw reveal lives outside the create dialog (shown once after success), plus the created email.
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setFieldError(null);
    // Build the payload, dropping empty optionals so zod optional() passes.
    const payload = {
      email: form.email.trim(),
      role: form.role,
      full_name: form.full_name.trim(),
      ...(form.student_id.trim() ? { student_id: form.student_id.trim() } : {}),
      ...(form.faculty.trim() ? { faculty: form.faculty.trim() } : {}),
      ...(form.department.trim() ? { department: form.department.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    };

    const parsed = createUserSchema.safeParse(payload);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง");
      return;
    }

    setPending(true);
    try {
      const res = await apiPost<CreateUserResponse>("/admin/users", parsed.data);
      onOpenChange(false);
      setForm({ ...EMPTY });
      onCreated();
      // Show temp pw once if backend returned it; otherwise direct admin to the export page.
      if (res.temp_password) {
        setCreatedEmail(res.user?.email ?? form.email);
        setTempPw(res.temp_password);
      } else {
        toast.message("ไม่ได้แสดงรหัสผ่านชั่วคราว", {
          description: "ส่งออกได้จากหน้ารหัสผ่านชั่วคราว (เฉพาะผู้ใช้ที่รอดำเนินการ)",
        });
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "ไม่สามารถสร้างผู้ใช้ได้";
      toast.error(msg);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>สร้างผู้ใช้</DialogTitle>
            <DialogDescription>
              ระบบจะสร้างรหัสผ่านชั่วคราวโดยอัตโนมัติ ต้องระบุรหัสนักศึกษาสำหรับนักศึกษา
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cu-email">อีเมล</Label>
              <Input
                id="cu-email"
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>บทบาท</Label>
              <Select value={form.role} onValueChange={(v) => set("role", v as Role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">นักศึกษา</SelectItem>
                  <SelectItem value="checkin_staff">เจ้าหน้าที่เช็คอิน</SelectItem>
                  <SelectItem value="admin">ผู้ดูแลระบบ</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu-sid">
                รหัสนักศึกษา{form.role === "student" ? "" : " (ไม่บังคับ)"}
              </Label>
              <Input
                id="cu-sid"
                value={form.student_id}
                onChange={(e) => set("student_id", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cu-name">ชื่อ-นามสกุล</Label>
              <Input
                id="cu-name"
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu-faculty">คณะ (ไม่บังคับ)</Label>
              <Input
                id="cu-faculty"
                value={form.faculty}
                onChange={(e) => set("faculty", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu-dept">สาขา (ไม่บังคับ)</Label>
              <Input
                id="cu-dept"
                value={form.department}
                onChange={(e) => set("department", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cu-phone">โทรศัพท์ (ไม่บังคับ)</Label>
              <Input
                id="cu-phone"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>
          </div>

          {fieldError ? <p className="text-sm text-destructive">{fieldError}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              ยกเลิก
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "กำลังสร้าง…" : "สร้าง"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TempPasswordDialog
        open={tempPw !== null}
        password={tempPw}
        email={createdEmail}
        onClose={() => {
          // Clear so the secret never lingers in component state.
          setTempPw(null);
          setCreatedEmail(null);
        }}
      />
    </>
  );
}
