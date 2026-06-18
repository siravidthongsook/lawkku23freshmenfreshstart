"use client";

// Scanner page: QR camera/manual-token scan + recent scan result + manual search, all within one event.
//
// SAFETY (never-false-success): the scan network call lives HERE. Any thrown ApiError / non-2xx / offline
// is converted to a `network_error` result — we NEVER synthesize a `checked_in_success`. Only an explicit
// `checked_in_success` returned by the server is treated as a success.
import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { formatBangkok } from "@/lib/time";
import { QrScanner } from "@/components/staff/qr-scanner";
import { ScanResultPanel } from "@/components/staff/scan-result-panel";
import { ManualSearch } from "@/components/staff/manual-search";
import { primeAudio } from "@/components/staff/feedback";
import type { ScanResponse, StaffCheckinContext } from "@/components/staff/types";

// How long a scan result stays on screen before auto-clearing back to the idle "ready to scan" panel.
const RESULT_AUTO_CLEAR_MS = 6000;
// Periodic ctx refresh so the open/closed badge + counts don't go stale on a phone left open.
const CTX_REFRESH_MS = 30000;

const STAFF_ROLES = ["checkin_staff", "admin"] as const;

function ScannerContent({ eventId }: { eventId: string }) {
  const [ctx, setCtx] = useState<StaffCheckinContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);
  // Guard against overlapping scans (camera can fire repeatedly). Token of the last in-flight scan.
  const inFlightRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);

  // Auto-clear timer for the last scan result (reset panel to "พร้อมสแกน" idle).
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCtx = useCallback(async () => {
    try {
      const res = await apiGet<StaffCheckinContext>(`/staff/events/${eventId}/checkin`);
      setCtx(res);
      setCtxError(null);
    } catch (err) {
      setCtxError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดกิจกรรมได้");
    }
  }, [eventId]);

  useEffect(() => {
    void loadCtx();
  }, [loadCtx]);

  // Periodically refresh ctx so the open/closed badge + counts stay fresh on a long-open phone (:36).
  useEffect(() => {
    const id = setInterval(() => void loadCtx(), CTX_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadCtx]);

  // Show a result and (re)arm the auto-clear so a stale success card can't be mistaken for a fresh scan (:58).
  const showResult = useCallback((res: ScanResponse) => {
    setResult(res);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    // network_error keeps its retry button on screen — don't auto-dismiss it.
    if (res.result !== "network_error") {
      clearTimerRef.current = setTimeout(() => setResult(null), RESULT_AUTO_CLEAR_MS);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  // Single choke-point for a scan. Online-only: any failure → network_error, never success.
  const handleToken = useCallback(
    async (token: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      lastTokenRef.current = token;
      primeAudio(); // a scan is a user gesture — unlock the AudioContext for the result beep
      try {
        const res = await apiPost<ScanResponse>(`/events/${eventId}/checkins/scan`, {
          qr_token: token,
        });
        // Trust ONLY the server's explicit result code.
        showResult(res);
        // Refresh ctx after EVERY round-trip (:36): counts may have changed and the window may have just
        // opened/closed server-side (e.g. a checkin_not_open/closed result should re-sync the badge).
        void loadCtx();
      } catch {
        // Thrown ApiError / network failure / non-2xx — surface retry, NEVER a success.
        // OFFLINE NOTE (:64): by design there is NO offline queue (V1 non-goal). Each failed scan is a
        // per-person network_error with retry; venue wifi must be online to check anyone in.
        showResult({ result: "network_error", registrationId: undefined });
      } finally {
        inFlightRef.current = false;
      }
    },
    [eventId, loadCtx, showResult],
  );

  const retry = useCallback(() => {
    if (lastTokenRef.current) void handleToken(lastTokenRef.current);
  }, [handleToken]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/staff/events">
          <ArrowLeft className="size-4" /> กิจกรรมทั้งหมด
        </Link>
      </Button>

      {/* Event header + live counts. */}
      <Card>
        <CardHeader className="pb-3">
          {ctx ? (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="text-lg">{ctx.event.title}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  เช็คอิน: {formatBangkok(ctx.event.checkinOpenAt) || "—"} →{" "}
                  {formatBangkok(ctx.event.checkinCloseAt) || "—"}
                </p>
              </div>
              <Badge
                className={
                  ctx.event.checkinOpen
                    ? "bg-green-100 text-green-800 border-transparent"
                    : "bg-slate-200 text-slate-700 border-transparent"
                }
              >
                {ctx.event.checkinOpen ? "เปิดเช็คอิน" : "ปิดเช็คอิน"}
              </Badge>
            </div>
          ) : ctxError ? (
            <CardTitle className="text-base text-muted-foreground">{ctxError}</CardTitle>
          ) : (
            <Skeleton className="h-6 w-64" />
          )}
        </CardHeader>
        {ctx && (
          <CardContent className="pt-0">
            <div className="flex gap-6 text-sm">
              <span>
                <span className="text-2xl font-semibold">{ctx.counts.checkedIn}</span>
                <span className="text-muted-foreground"> เช็คอินแล้ว</span>
              </span>
              <Separator orientation="vertical" className="h-9" />
              <span>
                <span className="text-2xl font-semibold">{ctx.counts.registered}</span>
                <span className="text-muted-foreground"> ลงทะเบียนแล้ว</span>
              </span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Recent scan result — always visible above the fold so staff see the latest outcome. */}
      <ScanResultPanel result={result} onRetry={retry} />

      <Tabs defaultValue="scan">
        {/* h-auto so list grows to fit the taller h-11 triggers (else active box overflows) */}
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value="scan" className="h-11 text-base">
            สแกน QR
          </TabsTrigger>
          <TabsTrigger value="manual" className="h-11 text-base">
            ค้นหาด้วยตนเอง
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-4">
          <QrScanner onToken={handleToken} />
        </TabsContent>

        <TabsContent value="manual" className="mt-4">
          <ManualSearch eventId={eventId} onCheckedIn={loadCtx} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function ScannerPage({ params }: { params: Promise<{ eventId: string }> }) {
  // Next 16: route params are a Promise in client pages — unwrap with use().
  const { eventId } = use(params);
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <ScannerContent eventId={eventId} />
      </AppShell>
    </RequireRole>
  );
}
