"use client";

// Page-level access gate. Wrap any role-protected page body with <RequireRole roles={[...]}>.
// Handles: loading, no-session redirect, role mismatch, and forced password change.
import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import type { Role } from "@/lib/types";

const CHANGE_PASSWORD_PATH = "/change-password";

export function RequireRole({
  roles,
  children,
}: {
  roles: Role[];
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    // Force password change before anything else (except the change-password page itself).
    if (user.passwordMustChange && pathname !== CHANGE_PASSWORD_PATH) {
      router.replace(CHANGE_PASSWORD_PATH);
    }
  }, [loading, user, pathname, router]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // Redirect in-flight (effect handles navigation) — render nothing to avoid flashing protected UI.
  if (!user) return null;
  if (user.passwordMustChange && pathname !== CHANGE_PASSWORD_PATH) return null;

  if (!roles.includes(user.role)) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-lg font-semibold">ไม่มีสิทธิ์เข้าถึง</h1>
        <p className="text-sm text-muted-foreground">
          บัญชีของคุณไม่มีสิทธิ์ในการดูหน้านี้
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
