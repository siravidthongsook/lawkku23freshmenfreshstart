"use client";

// Change password. Reachable as forced first-login interstitial (passwordMustChange) AND voluntarily.
// POST /api/auth/change-password { current_password, new_password }. Policy: 10–128 chars.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roleHome } from "@/components/public/role-home";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const MIN = 10;
const MAX = 128;

// One live checklist row: green check when satisfied, muted cross while pending/empty.
function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={cn("flex items-center gap-1.5 text-xs", ok ? "text-emerald-600" : "text-muted-foreground")}>
      {ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
      <span>{children}</span>
    </li>
  );
}

export default function ChangePasswordPage() {
  const { user, loading, refetch, logout } = useAuth();
  const router = useRouter();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Must be signed in to change a password; bounce anonymous visitors to login.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const forced = user?.passwordMustChange ?? false;

  // Live rule checks drive both the upfront checklist and the submit-enabled gate.
  const lengthOk = next.length >= MIN && next.length <= MAX;
  const differsOk = next.length > 0 && next !== current;
  const matchOk = confirm.length > 0 && next === confirm;
  const allFilled = current.length > 0 && next.length > 0 && confirm.length > 0;
  const canSubmit = !submitting && allFilled && lengthOk && differsOk && matchOk;

  function validate(): string | null {
    if (!lengthOk) return `รหัสผ่านใหม่ต้องมี ${MIN}–${MAX} ตัวอักษร`;
    if (next === current) return "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน";
    if (next !== confirm) return "รหัสผ่านใหม่ไม่ตรงกัน";
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/auth/change-password", { current_password: current, new_password: next });
      toast.success("เปลี่ยนรหัสผ่านเรียบร้อยแล้ว");
      await refetch(); // clears passwordMustChange in context
      router.replace(user ? roleHome(user.role) : "/events");
    } catch (err) {
      // Single surface for failures: inline only (success stays toast-only) to avoid redundant noise.
      const msg = err instanceof ApiError ? err.message : "ไม่สามารถเปลี่ยนรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง";
      setError(msg);
      setSubmitting(false);
    }
  }

  // Forced users can't reach normal nav; give them a logout escape so the page isn't a trap.
  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-muted/30 px-4">
        <Skeleton className="h-80 w-full max-w-sm rounded-xl" />
      </div>
    );
  }
  if (!user) return null; // redirect in flight

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Link href="/events" aria-label="หน้าแรก LawKKUFreshmenFreshStart23">
          <BrandLogo className="h-14" priority />
        </Link>
        <h1 className="text-xl font-bold tracking-tight">
          {forced ? "ตั้งรหัสผ่านใหม่" : "เปลี่ยนรหัสผ่าน"}
        </h1>
        {forced ? (
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            เพื่อความปลอดภัยของคุณ กรุณาตั้งรหัสผ่านใหม่ก่อนดำเนินการต่อ
          </p>
        ) : null}
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="current">รหัสผ่านปัจจุบัน</Label>
              <PasswordInput
                id="current"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="next">รหัสผ่านใหม่</Label>
              <PasswordInput
                id="next"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
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
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>

            {/* All rules listed upfront and checked live so users aren't surprised post-submit. */}
            <ul className="space-y-1">
              <Rule ok={lengthOk}>ความยาว {MIN}–{MAX} ตัวอักษร</Rule>
              <Rule ok={differsOk}>ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน</Rule>
              <Rule ok={matchOk}>ยืนยันรหัสผ่านให้ตรงกัน</Rule>
            </ul>

            {error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {submitting ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}
            </Button>
          </form>

          {/* Voluntary visitors can cancel; forced users get a logout escape so they aren't trapped. */}
          <div className="mt-4 text-center text-sm text-muted-foreground">
            {forced ? (
              <button type="button" onClick={onLogout} className="underline-offset-4 hover:underline">
                ออกจากระบบ
              </button>
            ) : (
              <Link href={roleHome(user.role)} className="underline-offset-4 hover:underline">
                ยกเลิก
              </Link>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
