"use client";

// Change password. Reachable as forced first-login interstitial (passwordMustChange) AND voluntarily.
// POST /api/auth/change-password { current_password, new_password }. Policy: 10–128 chars.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { roleHome } from "@/components/public/role-home";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

const MIN = 10;
const MAX = 128;

export default function ChangePasswordPage() {
  const { user, loading, refetch } = useAuth();
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

  function validate(): string | null {
    if (next.length < MIN || next.length > MAX) return `รหัสผ่านใหม่ต้องมี ${MIN}–${MAX} ตัวอักษร`;
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
      const msg = err instanceof ApiError ? err.message : "ไม่สามารถเปลี่ยนรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง";
      setError(msg);
      toast.error(msg);
      setSubmitting(false);
    }
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
          <Image src="/brand/platformlogo.png" alt="LawKKUFreshmenFreshStart23" width={56} height={56} className="rounded-xl" priority />
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
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="next">รหัสผ่านใหม่</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">{MIN}–{MAX} ตัวอักษร</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">ยืนยันรหัสผ่านใหม่</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}
            </Button>
          </form>

          {/* Voluntary visitors can bail out; forced users should complete the change. */}
          {!forced ? (
            <div className="mt-4 text-center text-sm text-muted-foreground">
              <Link href={roleHome(user.role)} className="underline-offset-4 hover:underline">
                ยกเลิก
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
