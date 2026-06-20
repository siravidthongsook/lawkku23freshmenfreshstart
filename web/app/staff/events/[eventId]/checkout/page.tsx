"use client";

// Staff check-OUT scanner — thin wrapper around the shared ScannerScreen (mode="out").
// All scan/manual/confirm logic lives in components/staff/scanner-screen.tsx (shared with check-in).
import { use } from "react";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ScannerScreen } from "@/components/staff/scanner-screen";

const STAFF_ROLES = ["checkin_staff", "admin"] as const;

export default function CheckoutScannerPage({ params }: { params: Promise<{ eventId: string }> }) {
  // Next 16: route params are a Promise in client pages — unwrap with use().
  const { eventId } = use(params);
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <ScannerScreen eventId={eventId} mode="out" />
      </AppShell>
    </RequireRole>
  );
}
