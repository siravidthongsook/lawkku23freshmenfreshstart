"use client";

// /me/points/[ledgerId] — wallet detail: "how / from whom" a single ledger entry came (plan §3.2a/§14).
// Hydrated from GET /me/points/:ledgerId — reason, signed amount, when, and source context resolved from
// the immutable metadata snapshot (event/counterpart/staff) + the live actor name. 404 = not the caller's.
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getLedgerEntry } from "@/lib/points-api";
import type { LedgerEntryDetail } from "@/lib/points-types";
import { formatBangkok } from "@/lib/time";
import { pointReasonLabel } from "@/lib/labels";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReasonIcon, DeltaPill } from "@/components/student/points-bits";

// One labelled fact row in the detail card.
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

// Read a string field out of the (unknown-shaped) metadata snapshot.
function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function metaNum(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

// Source-context facts per reason (plan §3.2a). Renders only the fields present in the snapshot.
function SourceContext({ entry }: { entry: LedgerEntryDetail }) {
  const m = entry.metadata;
  switch (entry.reasonCode) {
    case "checkin_in":
    case "checkin_out":
      return (
        <>
          <Fact label="กิจกรรม" value={metaStr(m, "eventTitle")} />
          <Fact label="โดยเจ้าหน้าที่" value={entry.actor?.fullName} />
        </>
      );
    case "assessment_completed":
      return <Fact label="กิจกรรม" value={metaStr(m, "eventTitle")} />;
    case "staff_grant_qr": {
      const ig = metaStr(m, "counterpartIg");
      return (
        <>
          <Fact label="กิจกรรม" value={metaStr(m, "eventTitle")} />
          <Fact label="จากเจ้าหน้าที่" value={entry.actor?.fullName} />
          <Fact label="แต้มต่อสิทธิ์" value={metaNum(m, "pointsValue")} />
          {ig && <Fact label="IG" value={ig} />}
        </>
      );
    }
    case "peer_connect": {
      const ig = metaStr(m, "counterpartIg");
      return (
        <>
          <Fact label="เพื่อน" value={metaStr(m, "counterpartName")} />
          <Fact label="ชื่อเล่น" value={metaStr(m, "counterpartNickname")} />
          <Fact label="บรรพ" value={metaNum(m, "counterpartGroup")} />
          {ig && (
            <Fact
              label="IG"
              value={
                <a
                  href={`https://instagram.com/${ig.replace(/^@/, "")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  {ig}
                </a>
              }
            />
          )}
        </>
      );
    }
    case "manual_adjust":
    case "correction_add":
    case "correction_reverse":
      return (
        <>
          <Fact label="โดย" value={entry.actor?.fullName} />
          <Fact label="เหตุผล" value={entry.reason} />
        </>
      );
    default:
      return null;
  }
}

function DetailInner({ ledgerId }: { ledgerId: string }) {
  const [entry, setEntry] = useState<LedgerEntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    setNotFound(false);
    setEntry(null);
    getLedgerEntry(ledgerId)
      .then((res) => {
        if (active) setEntry(res.entry);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดรายละเอียดได้");
      });
    return () => {
      active = false;
    };
  }, [ledgerId, reloadKey]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/me/points">
          <ArrowLeft className="size-4" /> กระเป๋าแต้ม
        </Link>
      </Button>

      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : notFound ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            ไม่พบรายการแต้มนี้
          </CardContent>
        </Card>
      ) : entry === null ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <ReasonIcon reason={entry.reasonCode} delta={entry.delta} />
            <div className="flex-1">
              <CardTitle className="text-base">{pointReasonLabel(entry.reasonCode)}</CardTitle>
              <p className="text-xs text-muted-foreground">{formatBangkok(entry.createdAt)}</p>
            </div>
            <DeltaPill delta={entry.delta} className="text-2xl" />
          </CardHeader>
          <CardContent>
            {entry.reversed && (
              <Badge variant="destructive" className="mb-3">
                ปรับแก้แล้ว
              </Badge>
            )}
            <div className="divide-y">
              <SourceContext entry={entry} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function WalletDetailPage({ params }: { params: Promise<{ ledgerId: string }> }) {
  // Next 16: route params are a Promise in client pages — unwrap with use().
  const { ledgerId } = use(params);
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <DetailInner ledgerId={ledgerId} />
      </AppShell>
    </RequireRole>
  );
}
