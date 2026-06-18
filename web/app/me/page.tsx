"use client";

// /me — account page. User edits own email + contact info (PATCH /auth/me).
// student_id/role are admin-only, so shown read-only here. Password change lives at /change-password.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound, ArrowRight } from "lucide-react";
import { apiPatch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

// Pragmatic email check — mirrors the browser's native validity without a heavyweight regex.
function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function AccountForm() {
  const { user, refetch } = useAuth();

  // Editable fields. Seed from current user; null contact fields render as empty string.
  const [email, setEmail] = useState(user?.email ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [faculty, setFaculty] = useState(user?.faculty ?? "");
  const [department, setDepartment] = useState(user?.department ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false);

  // Re-seed if the context user changes (e.g. after refetch).
  useEffect(() => {
    if (!user) return;
    setEmail(user.email ?? ""); // imported users have no email → empty string, not null
    setFullName(user.fullName);
    setFaculty(user.faculty ?? "");
    setDepartment(user.department ?? "");
    setPhone(user.phone ?? "");
  }, [user]);

  // Dirty = any field differs from the loaded user. Drives the leave-warning + disables the save button.
  const dirty = useMemo(() => {
    if (!user) return false;
    return (
      email.trim() !== (user.email ?? "") ||
      fullName.trim() !== user.fullName ||
      faculty.trim() !== (user.faculty ?? "") ||
      department.trim() !== (user.department ?? "") ||
      phone.trim() !== (user.phone ?? "")
    );
  }, [user, email, fullName, faculty, department, phone]);

  useUnsavedChanges(dirty);

  // Email is the login credential — changing it can lock the user out, so confirm before persisting.
  const emailChanged = user ? email.trim() !== (user.email ?? "") : false;

  if (!user) return null;

  // Persist the profile. Separated from the submit handler so the email-change confirm can call it directly.
  async function persist() {
    setError(null);
    setSubmitting(true);
    try {
      // Send empty contact fields as null (clears them); full_name required non-empty.
      // Email is optional (imported users have none) — omit when blank; backend rejects "".
      const body: Record<string, unknown> = {
        full_name: fullName.trim(),
        faculty: faculty.trim() || null,
        department: department.trim() || null,
        phone: phone.trim() || null,
      };
      if (email.trim()) body.email = email.trim();
      await apiPatch("/auth/me", body);
      await refetch();
      toast.success("บันทึกข้อมูลเรียบร้อยแล้ว");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ไม่สามารถบันทึกข้อมูลได้ กรุณาลองใหม่อีกครั้ง";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Email is optional (imported users have none); only validate format if one was entered.
    if (email.trim() && !isValidEmail(email.trim())) {
      setError("กรุณากรอกอีเมลให้ถูกต้อง");
      return;
    }
    // Email change → confirm first (it changes the login credential).
    if (emailChanged) {
      setEmailConfirmOpen(true);
      return;
    }
    void persist();
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">บัญชีของฉัน</h1>
        <p className="text-sm text-muted-foreground">แก้ไขอีเมลและข้อมูลส่วนตัวของคุณ</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">อีเมล</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">ใช้สำหรับเข้าสู่ระบบ</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fullName">ชื่อ-นามสกุล</Label>
              <Input
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>

            {/* บรรพ (group_number) — admin-managed, read-only here. */}
            {user.groupNumber != null ? (
              <div className="space-y-1.5">
                <Label htmlFor="groupNumber">บรรพ</Label>
                <Input id="groupNumber" value={String(user.groupNumber)} disabled readOnly />
                <p className="text-xs text-muted-foreground">แก้ไขได้โดยผู้ดูแลระบบเท่านั้น</p>
              </div>
            ) : null}

            {/* Read-only identity — only an admin can change these. */}
            {user.studentId ? (
              <div className="space-y-1.5">
                <Label htmlFor="studentId">รหัสนักศึกษา</Label>
                <Input id="studentId" value={user.studentId} disabled readOnly />
                <p className="text-xs text-muted-foreground">แก้ไขได้โดยผู้ดูแลระบบเท่านั้น</p>
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting || !dirty}>
              {submitting ? "กำลังบันทึก…" : "บันทึก"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Confirm email (login credential) changes — clearing this risk of self-lockout. */}
      <ConfirmDialog
        open={emailConfirmOpen}
        onOpenChange={setEmailConfirmOpen}
        title="ยืนยันการเปลี่ยนอีเมล?"
        description={`อีเมลนี้ใช้สำหรับเข้าสู่ระบบ หลังบันทึก คุณจะต้องใช้ "${email.trim()}" ในการเข้าสู่ระบบครั้งถัดไป`}
        confirmLabel="ยืนยันและบันทึก"
        onConfirm={persist}
      />

      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-6">
          <div>
            <p className="text-sm font-medium">รหัสผ่าน</p>
            <p className="text-xs text-muted-foreground">เปลี่ยนรหัสผ่านสำหรับเข้าสู่ระบบ</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/change-password">
              <KeyRound className="size-4" />
              เปลี่ยนรหัสผ่าน
            </Link>
          </Button>
        </CardContent>
      </Card>

      {/* Exit to the main events page once the user is done filling in their info. */}
      <Button asChild className="w-full">
        <Link href="/events">
          ไปยังหน้ากิจกรรม
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    </div>
  );
}

export default function AccountPage() {
  return (
    <RequireRole roles={["student", "checkin_staff", "admin"]}>
      <AppShell>
        <AccountForm />
      </AppShell>
    </RequireRole>
  );
}
