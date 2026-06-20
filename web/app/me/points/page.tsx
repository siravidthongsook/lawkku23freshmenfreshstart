"use client";

// /me/points — student wallet: big balance + rank pill + paginated point history (newest first).
// Each row → tap the chevron to open the hydrated detail sub-page (/me/points/[ledgerId]).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Trophy, Wallet, UserPlus } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getWallet, getLeaderboard } from "@/lib/points-api";
import type { LedgerEntry } from "@/lib/points-types";
import { formatBangkok } from "@/lib/time";
import { pointReasonLabel } from "@/lib/labels";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ReasonIcon, DeltaPill } from "@/components/student/points-bits";

const PAGE_SIZE = 25;

function HistoryRow({ entry }: { entry: LedgerEntry }) {
  return (
    <Link href={`/me/points/${entry.id}`} className="block">
      <Card className="transition-colors hover:bg-accent/50">
        <CardContent className="flex items-center gap-3 py-3">
          <ReasonIcon reason={entry.reason_code} delta={entry.delta} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{pointReasonLabel(entry.reason_code)}</p>
            <p className="text-xs text-muted-foreground">{formatBangkok(entry.created_at)}</p>
          </div>
          <DeltaPill delta={entry.delta} />
          {/* right-aligned "รายละเอียด" affordance (plan §14) */}
          <span className="flex shrink-0 items-center text-xs text-muted-foreground">
            <span className="hidden sm:inline">รายละเอียด</span>
            <ChevronRight className="size-4" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

function WalletInner() {
  const [balance, setBalance] = useState<number | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (nextOffset: number, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const wallet = await getWallet({ limit: PAGE_SIZE, offset: nextOffset });
      setBalance(wallet.balance);
      setTotal(wallet.total);
      setOffset(nextOffset);
      setHistory((prev) => (replace ? wallet.history : [...prev, ...wallet.history]));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดแต้มได้");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0, true);
    // rank is best-effort: a failure here must not break the wallet.
    getLeaderboard({ limit: 1 })
      .then((r) => setRank(r.myRank?.rank ?? null))
      .catch(() => setRank(null));
  }, [load, reloadKey]);

  const hasMore = history.length < total;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">กระเป๋าแต้มของฉัน</h1>

      {/* Balance hero + rank pill */}
      <Card className="bg-primary text-primary-foreground">
        <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
          <Wallet className="size-6 opacity-80" />
          {balance === null ? (
            <Skeleton className="h-12 w-28 bg-primary-foreground/20" />
          ) : (
            <p className="text-5xl font-bold tabular-nums">{balance}</p>
          )}
          <p className="text-sm opacity-80">แต้มสะสมทั้งหมด</p>
          {rank != null && (
            <Link
              href="/leaderboard"
              className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary-foreground/15 px-3 py-1 text-sm"
            >
              <Trophy className="size-4" /> อันดับที่ {rank}
            </Link>
          )}
        </CardContent>
      </Card>

      {/* Earning shortcuts (plan §14 — teach the earning path) */}
      <div className="grid grid-cols-2 gap-3">
        <Button asChild variant="outline" className="h-12">
          <Link href="/me/connect">
            <UserPlus className="size-4" /> เพิ่มเพื่อน
          </Link>
        </Button>
        <Button asChild variant="outline" className="h-12">
          <Link href="/leaderboard">
            <Trophy className="size-4" /> อันดับ
          </Link>
        </Button>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">ประวัติแต้ม</h2>

        {error ? (
          <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : balance === null && loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              ยังไม่มีแต้ม เริ่มเก็บแต้มได้จากการเช็คอินกิจกรรมและเพิ่มเพื่อน
            </CardContent>
          </Card>
        ) : (
          <>
            {history.map((e) => (
              <HistoryRow key={e.id} entry={e} />
            ))}
            {hasMore && (
              <Button
                variant="outline"
                className="w-full"
                disabled={loading}
                onClick={() => void load(offset + PAGE_SIZE, false)}
              >
                {loading ? "กำลังโหลด…" : "โหลดเพิ่ม"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function WalletPage() {
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <WalletInner />
      </AppShell>
    </RequireRole>
  );
}
