"use client";

// Admin section layout: gate to admin role + wrap in AppShell.
// Nav lives in AppShell's role-based top nav (Events/Users/Audit) — no second-level subnav to avoid duplication.
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole roles={["admin"]}>
      <AppShell>{children}</AppShell>
    </RequireRole>
  );
}
