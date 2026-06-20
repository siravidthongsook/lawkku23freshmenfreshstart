"use client";

// Shared staff scanner surface for BOTH check-in and check-out (mode prop). QR scan + manual search,
// scoped to one event.
//
// CONFIRM-ON-SCAN: a QR scan first runs a server dry-run (dry_run:true) that validates everything but
// commits nothing. If it returns "ready", we show a confirm dialog with the resolved identity; only on
// confirm do we send the real commit scan. Any reject/already-done outcome is shown immediately (no
// confirm needed). This mirrors the manual-search confirm so staff always eyeball WHO before committing.
//
// SAFETY (never-false-success): the scan network calls live HERE. Any thrown ApiError / non-2xx / offline
// becomes a `network_error` result — we NEVER synthesize a success. Only an explicit success result code
// returned by the server is treated as a success.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { regStatusLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { QrScanner } from "@/components/staff/qr-scanner";
import { ScanResultPanel } from "@/components/staff/scan-result-panel";
import { RecentScans } from "@/components/staff/recent-scans";
import { ManualSearch } from "@/components/staff/manual-search";
import { primeAudio } from "@/components/staff/feedback";
import type {
  ScanResponse,
  ScanPreviewResponse,
  DisplayScan,
  RecentScan,
  StaffCheckinContext,
} from "@/components/staff/types";

const RESULT_AUTO_CLEAR_MS = 6000;
const CTX_REFRESH_MS = 30000;
const RECENT_LIMIT = 5;

type Mode = "in" | "out";

// All mode-varying copy in one place so the JSX below stays direction-agnostic.
const COPY = {
  in: {
    pageTitle: "เช็คอิน",
    windowLabel: "เช็คอิน",
    openBadge: "เปิดเช็คอิน",
    closedBadge: "ปิดเช็คอิน",
    confirmTitle: "ยืนยันการเช็คอิน",
    confirmVerb: "ยืนยันเช็คอิน",
    confirmLabel: "เช็คอิน",
  },
  out: {
    pageTitle: "เช็คเอาท์",
    windowLabel: "เช็คเอาท์",
    openBadge: "เปิดเช็คเอาท์",
    closedBadge: "ปิดเช็คเอาท์",
    confirmTitle: "ยืนยันการเช็คเอาท์",
    confirmVerb: "ยืนยันเช็คเอาท์",
    confirmLabel: "เช็คเอาท์",
  },
} as const;

function bangkokClock(): string {
  return new Date().toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// A scan awaiting staff confirm: the token to commit + the resolved preview (identity/status).
type PendingConfirm = { token: string; preview: ScanPreviewResponse };

export function ScannerScreen({ eventId, mode }: { eventId: string; mode: Mode }) {
  const t = COPY[mode];
  const [ctx, setCtx] = useState<StaffCheckinContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [result, setResult] = useState<DisplayScan | null>(null);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const inFlightRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);
  const seqRef = useRef(0);
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

  useEffect(() => {
    const id = setInterval(() => void loadCtx(), CTX_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadCtx]);

  const showProcessing = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    setResult({ result: "processing", seq: ++seqRef.current });
  }, []);

  const showResult = useCallback((res: ScanResponse) => {
    const seq = ++seqRef.current;
    setResult({ ...res, seq });
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (res.result !== "network_error") {
      clearTimerRef.current = setTimeout(() => setResult(null), RESULT_AUTO_CLEAR_MS);
    }
    if (res.result !== "network_error") {
      setRecent((prev) =>
        [
          {
            seq,
            code: res.result,
            fullName: res.fullName ?? null,
            studentId: res.studentId ?? null,
            at: bangkokClock(),
          },
          ...prev,
        ].slice(0, RECENT_LIMIT),
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  // Step 1 of a scan: resolve-only dry-run. "ready" → confirm dialog; anything else → show it now.
  const handleToken = useCallback(
    async (token: string) => {
      if (inFlightRef.current || pending) return; // ignore camera re-fires while busy or awaiting confirm
      inFlightRef.current = true;
      lastTokenRef.current = token;
      primeAudio();
      showProcessing();
      try {
        const res = await apiPost<ScanPreviewResponse>(`/events/${eventId}/checkins/scan`, {
          qr_token: token,
          scan_type: mode,
          dry_run: true,
        });
        if (res.result === "ready") {
          setResult(null); // clear the "processing" card while the confirm dialog is up
          setPending({ token, preview: res });
        } else {
          // Reject / already-done — show immediately, no confirm. Cast: result is a committed code here.
          showResult(res as ScanResponse);
          void loadCtx();
        }
      } catch {
        showResult({ result: "network_error", registrationId: undefined });
      } finally {
        inFlightRef.current = false;
      }
    },
    [eventId, mode, pending, loadCtx, showResult, showProcessing],
  );

  // Step 2: staff confirmed — send the real commit scan and show the authoritative outcome.
  const commitScan = useCallback(async () => {
    if (!pending) return;
    const token = pending.token;
    setPending(null);
    inFlightRef.current = true;
    showProcessing();
    try {
      const res = await apiPost<ScanResponse>(`/events/${eventId}/checkins/scan`, {
        qr_token: token,
        scan_type: mode,
        dry_run: false,
      });
      showResult(res);
      void loadCtx();
    } catch {
      showResult({ result: "network_error", registrationId: undefined });
    } finally {
      inFlightRef.current = false;
    }
  }, [eventId, mode, pending, loadCtx, showResult, showProcessing]);

  // network_error retry re-runs the dry-run for the last token.
  const retry = useCallback(() => {
    if (lastTokenRef.current) void handleToken(lastTokenRef.current);
  }, [handleToken]);

  const p = pending?.preview;

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
                {/* Check-in window + badge only apply to IN mode (ctx carries the check-in window, not the
                    scan-out window). OUT mode shows just the title + counts; the scan itself gates timing. */}
                {mode === "in" && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t.windowLabel}: {formatBangkok(ctx.event.checkinOpenAt) || "—"} →{" "}
                    {formatBangkok(ctx.event.checkinCloseAt) || "—"}
                  </p>
                )}
              </div>
              {mode === "in" && (
                <Badge
                  className={
                    ctx.event.checkinOpen
                      ? "bg-green-100 text-green-800 border-transparent"
                      : "bg-slate-200 text-slate-700 border-transparent"
                  }
                >
                  {ctx.event.checkinOpen ? t.openBadge : t.closedBadge}
                </Badge>
              )}
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

      {/* Recent-scans strip: confirm THIS person even after the card advances at a fast gate. */}
      <RecentScans items={recent} />

      <Tabs defaultValue="scan">
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value="scan" className="h-11 text-base">
            สแกน QR
          </TabsTrigger>
          <TabsTrigger value="manual" className="h-11 text-base">
            ค้นหาด้วยตนเอง
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-4">
          <QrScanner onToken={handleToken} disabled={pending !== null} />
        </TabsContent>

        <TabsContent value="manual" className="mt-4">
          <ManualSearch eventId={eventId} mode={mode} onChanged={loadCtx} />
        </TabsContent>
      </Tabs>

      {/* Confirm-on-scan: resolved identity from the QR dry-run; commit only on confirm. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={t.confirmTitle}
        description={
          p
            ? `${t.confirmVerb}: ${p.fullName ?? "ไม่ทราบชื่อ"} · รหัสนักศึกษา ${p.studentId ?? "ไม่มี"}${
                p.status ? ` · สถานะ ${regStatusLabel(p.status)}` : ""
              }`
            : undefined
        }
        confirmLabel={t.confirmLabel}
        onConfirm={commitScan}
      />
    </div>
  );
}
