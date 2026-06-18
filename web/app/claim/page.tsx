"use client";

// First-time account claim for freshmen (student_id) and mentors (username).
// 2nd factor = group number. Sets the user's own password + a session, then redirects
// like login success. GENERIC error only on any mismatch (no enumeration).
// POST /auth/claim { identifier, group_number, new_password } → { user, password_must_change }.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Check, X, Loader2 } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roleHome } from "@/components/public/role-home";
import type { Role } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const MIN = 10;
const MAX = 128;
// Single generic message for all claim failures — mirrors login (no enumeration).
const GENERIC_ERROR = "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบรหัสนักศึกษา/ชื่อผู้ใช้ และหมู่ของคุณ";

// Claim response mirrors login: wrapped + snake_case (see src/modules/auth/routes.ts).
type ClaimResponse = { user: { role: Role }; password_must_change: boolean };

// One live checklist row: green check when satisfied, muted cross while pending/empty.
function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={cn("flex items-center gap-1.5 text-xs", ok ? "text-emerald-600" : "text-muted-foreground")}>
      {ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
      <span>{children}</span>
    </li>
  );
}

export default function ClaimPage() {
  const { user, loading, refetch } = useAuth();
  const router = useRouter();

  // identifier = student_id (freshmen) OR username (mentors); backend looks up by either.
  const [identifier, setIdentifier] = useState("");
  const [groupNumber, setGroupNumber] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Refocus identifier after a failed claim so the user can retype without reaching for the field.
  const identifierRef = useRef<HTMLInputElement>(null);

  // Already-authed visitors shouldn't see the claim form; bounce to their role home.
  useEffect(() => {
    if (loading || !user) return;
    router.replace(roleHome(user.role));
  }, [loading, user, router]);

  // Live rule checks drive both the upfront checklist and the submit-enabled gate.
  const groupOk = groupNumber.trim().length > 0 && Number.isFinite(Number(groupNumber));
  const lengthOk = newPassword.length >= MIN && newPassword.length <= MAX;
  const matchOk = confirm.length > 0 && newPassword === confirm;
  const canSubmit =
    !submitting && identifier.trim().length > 0 && groupOk && lengthOk && matchOk;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Client-side guard so users aren't surprised post-submit; server still validates.
    if (newPassword !== confirm) {
      setError("รหัสผ่านใหม่ไม่ตรงกัน");
      return;
    }
    if (!lengthOk) {
      setError(`รหัสผ่านใหม่ต้องมี ${MIN}–${MAX} ตัวอักษร`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Claim sets the session cookie like login; read role from the response for redirect.
      const res = await apiPost<ClaimResponse>("/auth/claim", {
        identifier: identifier.trim(),
        group_number: Number(groupNumber),
        new_password: newPassword,
      });
      await refetch(); // populate auth context from the new session
      // Mirror login redirect: must-change → /change-password, else role home.
      if (res.password_must_change) {
        router.replace("/change-password");
        return;
      }
      router.replace(roleHome(res.user.role));
    } catch (err) {
      // Never leak account existence/claimed state. Generic message for all failures.
      if (err instanceof ApiError && err.status >= 500) {
        setError("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      } else {
        setError(GENERIC_ERROR);
      }
      setSubmitting(false);
      identifierRef.current?.focus();
    }
  }

  // While the auth check runs or a redirect is in flight, show a spinner instead of the form flash.
  if (loading || user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-muted/30 px-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="กำลังโหลด" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="หน้าแรก LawKKUFreshmenFreshStart23">
          <Image src="/brand/platformlogo.png" alt="LawKKUFreshmenFreshStart23" width={56} height={56} className="rounded-xl" priority />
        </Link>
        {/* Title on two lines: action label above, event name below */}
        <h1 className="text-center text-xl font-bold tracking-tight">
          <span className="block">ตั้งรหัสผ่านครั้งแรก</span>
          <span className="block">LawKKUFreshmenFreshStart23</span>
        </h1>
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          สำหรับการเข้าใช้งานครั้งแรก กรอกรหัสนักศึกษา/ชื่อผู้ใช้ หมู่ของคุณ และตั้งรหัสผ่านใหม่
        </p>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="identifier">รหัสนักศึกษา / ชื่อผู้ใช้</Label>
              <Input
                id="identifier"
                ref={identifierRef}
                type="text"
                inputMode="text"
                autoComplete="username"
                autoCapitalize="none"
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  if (error) setError(null); // clear stale error while the user fixes input
                }}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group">หมู่</Label>
              <Input
                id="group"
                type="number"
                inputMode="numeric"
                min={1}
                value={groupNumber}
                onChange={(e) => {
                  setGroupNumber(e.target.value);
                  if (error) setError(null);
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">รหัสผ่านใหม่</Label>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (error) setError(null);
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">ยืนยันรหัสผ่านใหม่</Label>
              <PasswordInput
                id="confirm"
                // off here so the browser doesn't pop its "generate strong password" UI on the 2nd field.
                autoComplete="off"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (error) setError(null);
                }}
                required
              />
            </div>

            {/* Password rules listed upfront and checked live so users aren't surprised post-submit. */}
            <ul className="space-y-1">
              <Rule ok={lengthOk}>ความยาว {MIN}–{MAX} ตัวอักษร</Rule>
              <Rule ok={matchOk}>ยืนยันรหัสผ่านให้ตรงกัน</Rule>
            </ul>

            {error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {submitting ? "กำลังตั้งรหัสผ่าน…" : "ตั้งรหัสผ่านและเข้าสู่ระบบ"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/login" className="underline-offset-4 hover:underline">
              ตั้งรหัสผ่านแล้ว? เข้าสู่ระบบ
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
