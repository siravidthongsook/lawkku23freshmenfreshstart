"use client";

// /leaderboard — app-wide ranked students (balance DESC, earliest-to-reach tiebreak). Login-only (any role).
// Sticky "my rank" strip so the caller sees where they stand even off-page (plan §14); optional บรรพ filter.
import { useCallback, useEffect, useState } from "react";
import { Trophy, Medal, Download } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { downloadFile } from "@/components/admin-tools/download";
import { getLeaderboard } from "@/lib/points-api";
import type { LeaderboardRow } from "@/lib/points-types";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const GROUPS = Array.from({ length: 16 }, (_, i) => i + 1); // บรรพ 1..16

// Medal tint for the top-3 podium positions.
function rankTint(rank: number): string {
  if (rank === 1) return "text-amber-500";
  if (rank === 2) return "text-slate-400";
  if (rank === 3) return "text-amber-700";
  return "text-muted-foreground";
}

function Row({ row, me }: { row: LeaderboardRow; me: boolean }) {
  return (
    <Card className={cn(me && "ring-2 ring-primary")}>
      <CardContent className="flex items-center gap-3 py-3">
        <span className={cn("w-8 text-center text-lg font-bold tabular-nums", rankTint(row.rank))}>
          {row.rank <= 3 ? <Medal className={cn("mx-auto size-5", rankTint(row.rank))} /> : row.rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {row.nickname ? `${row.nickname} · ` : ""}
            {row.fullName}
          </p>
          {row.groupNumber != null && (
            <p className="text-xs text-muted-foreground">บรรพ {row.groupNumber}</p>
          )}
        </div>
        <span className="font-semibold tabular-nums">{row.pointsBalance}</span>
      </CardContent>
    </Card>
  );
}

function LeaderboardInner() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [myRank, setMyRank] = useState<{ rank: number; pointsBalance: number } | null>(null);
  const [group, setGroup] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(
    async (nextOffset: number, replace: boolean, groupVal: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getLeaderboard({
          limit: PAGE_SIZE,
          offset: nextOffset,
          groupNumber: groupVal === "all" ? undefined : Number(groupVal),
        });
        setTotal(res.total);
        setOffset(nextOffset);
        setMyRank(res.myRank);
        setRows((prev) => (replace ? res.leaderboard : [...prev, ...res.leaderboard]));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดอันดับได้");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Reload from the top whenever the group filter changes.
  useEffect(() => {
    void load(0, true, group);
  }, [load, group, reloadKey]);

  const hasMore = rows.length < total;
  const isAdmin = user?.role === "admin";
  const [exporting, setExporting] = useState(false);

  // Admin CSV export — respects the current บรรพ filter (plan §5/§8). Goes through the /api proxy.
  async function exportCsv() {
    setExporting(true);
    try {
      const query = group === "all" ? "" : `?group_number=${group}`;
      const { rowCount } = await downloadFile(`/admin/leaderboard/export${query}`, "leaderboard.csv");
      toast.success(rowCount != null ? `ส่งออก ${rowCount} รายการแล้ว` : "ส่งออกแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ส่งออกไม่สำเร็จ");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">อันดับแต้ม</h1>
        {isAdmin ? (
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
            <Download className="size-4" />
            {exporting ? "กำลังส่งออก…" : "ส่งออก CSV"}
          </Button>
        ) : null}
      </div>

      {/* Sticky my-rank strip (plan §14) — only meaningful for ranked students. */}
      {myRank && (
        <div className="sticky top-2 z-10">
          <Card className="border-primary bg-primary text-primary-foreground shadow-lg">
            <CardContent className="flex items-center gap-3 py-3">
              <Trophy className="size-5" />
              <div className="flex-1">
                <p className="text-sm opacity-80">อันดับของคุณ</p>
                <p className="text-lg font-bold">อันดับที่ {myRank.rank}</p>
              </div>
              <span className="text-lg font-bold tabular-nums">{myRank.pointsBalance} แต้ม</span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* บรรพ filter (rank stays app-wide; this narrows the visible slice). */}
      <Select value={group} onValueChange={setGroup}>
        <SelectTrigger className="w-full sm:w-52" aria-label="กรองตามบรรพ">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">ทุกบรรพ</SelectItem>
          {GROUPS.map((g) => (
            <SelectItem key={g} value={String(g)}>
              บรรพ {g}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : rows.length === 0 && loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีผู้มีแต้มในอันดับ
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Row key={r.userId} row={r} me={user?.id === r.userId} />
          ))}
          {hasMore && (
            <Button
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => void load(offset + PAGE_SIZE, false, group)}
            >
              {loading ? "กำลังโหลด…" : "โหลดเพิ่ม"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function LeaderboardPage() {
  return (
    <RequireRole roles={["student", "checkin_staff", "admin"]}>
      <AppShell>
        <LeaderboardInner />
      </AppShell>
    </RequireRole>
  );
}
