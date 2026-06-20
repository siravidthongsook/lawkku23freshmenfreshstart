"use client";

// Staff check-IN scanner — thin wrapper around the shared ScannerScreen (mode="in").
// All scan/manual/confirm logic lives in components/staff/scanner-screen.tsx (shared with check-out).
import { use } from "react";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ScannerScreen } from "@/components/staff/scanner-screen";

const STAFF_ROLES = ["checkin_staff", "admin"] as const;

export default function CheckinScannerPage({ params }: { params: Promise<{ eventId: string }> }) {
  // Next 16: route params are a Promise in client pages — unwrap with use().
  const { eventId } = use(params);
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <ScannerScreen eventId={eventId} mode="in" />
      </AppShell>
    </RequireRole>
  );
}
