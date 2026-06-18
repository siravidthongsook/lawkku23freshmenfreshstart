"use client";

// /me — account page. User edits own email + contact info (PATCH /auth/me).
// student_id/role are admin-only, so shown read-only here. Password change lives at /change-password.
import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { apiPatch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

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

  // Re-seed if the context user changes (e.g. after refetch).
  useEffect(() => {
    if (!user) return;
    setEmail(user.email);
    setFullName(user.fullName);
    setFaculty(user.faculty ?? "");
    setDepartment(user.department ?? "");
    setPhone(user.phone ?? "");
  }, [user]);

  if (!user) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Send empty contact fields as null (clears them); email/full_name required non-empty.
      await apiPatch("/auth/me", {
        email: email.trim(),
        full_name: fullName.trim(),
        faculty: faculty.trim() || null,
        department: department.trim() || null,
        phone: phone.trim() || null,
      });
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

            <div className="space-y-1.5">
              <Label htmlFor="faculty">คณะ</Label>
              <Input id="faculty" value={faculty} onChange={(e) => setFaculty(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="department">สาขา/ภาควิชา</Label>
              <Input
                id="department"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phone">เบอร์โทรศัพท์</Label>
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

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

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "กำลังบันทึก…" : "บันทึก"}
            </Button>
          </form>
        </CardContent>
      </Card>

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
