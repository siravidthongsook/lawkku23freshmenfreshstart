"use client";

// Login for all roles. GENERIC error only (no user enumeration). On success:
// password_must_change → /change-password, else route by role (or ?next= if present).
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roleHome } from "@/components/public/role-home";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const GENERIC_ERROR = "อีเมลหรือรหัสผ่านไม่ถูกต้อง";

function LoginForm() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  // identifier = email OR student ID; backend accepts either.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Refocus password after a failed login so the user can retype without reaching for the field.
  const passwordRef = useRef<HTMLInputElement>(null);

  // Already-authed visitors shouldn't see the login form; bounce to their role home (or safe ?next).
  useEffect(() => {
    if (loading || !user) return;
    const dest = next && next.startsWith("/") ? next : roleHome(user.role);
    router.replace(dest);
  }, [loading, user, next, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const me = await login(identifier.trim(), password);
      if (me.passwordMustChange) {
        router.replace("/change-password");
        return;
      }
      // Honor a safe internal ?next, else fall back to the role home.
      const dest = next && next.startsWith("/") ? next : roleHome(me.role);
      router.replace(dest);
    } catch (err) {
      // Never leak whether the email exists. Surface a single generic message for all auth failures.
      if (err instanceof ApiError && err.status >= 500) {
        setError("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      } else {
        setError(GENERIC_ERROR);
      }
      setSubmitting(false);
      passwordRef.current?.focus();
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
          <span className="block">เข้าสู่ระบบ</span>
          <span className="block">LawKKUFreshmenFreshStart23</span>
        </h1>
      </div>

      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="identifier">อีเมล หรือ รหัสนักศึกษา</Label>
              <Input
                id="identifier"
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
              <Label htmlFor="password">รหัสผ่าน</Label>
              <PasswordInput
                id="password"
                ref={passwordRef}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null); // clear stale error while the user fixes input
                }}
                required
              />
            </div>

            {error ? (
              <div role="alert" className="space-y-1">
                <p className="text-sm font-medium text-destructive">{error}</p>
                {/* Recovery hint: temp-password users often mistype the issued password. */}
                <p className="text-xs text-muted-foreground">
                  ลืมรหัสผ่าน หรือใช้รหัสผ่านชั่วคราว?{" "}
                  <Link href="/forgot-password" className="underline underline-offset-4">
                    ขอความช่วยเหลือ
                  </Link>
                </p>
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting || !identifier || !password}>
              {submitting ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/forgot-password" className="underline-offset-4 hover:underline">
              ลืมรหัสผ่าน?
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-muted/30 px-4">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="กำลังโหลด" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
