"use client";

// Admin > Staff budget OVERVIEW (plan §4.7/§14). Answers the event-day question "who's low, top them up".
// Sorted budget ASC by default (lowest first), low rows tinted amber, quick per-row topup + multi-select
// bulk topup (one tx). Each row links to the per-staff detail page.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, ArrowUp, ArrowDown } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getStaffBudgets, topupStaffBudget, topupStaffBudgetBulk } from "@/lib/points-api";
import type { StaffBudgetOverviewRow } from "@/lib/points-types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TopupDialog } from "@/components/points/topup-dialog";

type SortOrder = "asc" | "desc";

export default function StaffBudgetOverviewPage() {
  const [rows, setRows] = useState<StaffBudgetOverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<SortOrder>("asc"); // lowest-first default (§14)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Client-side filters (dataset is small — whole staff list loaded at once).
  const [query, setQuery] = useState("");
  const [minBudget, setMinBudget] = useState(""); // empty = no lower bound
  const [maxBudget, setMaxBudget] = useState(""); // empty = no upper bound

  // Dialog: single-staff topup (null) or bulk (the selected set). `bulk` distinguishes the two.
  const [topupTarget, setTopupTarget] = useState<{ row: StaffBudgetOverviewRow | null; bulk: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getStaffBudgets();
      setRows(res.staff);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดข้อมูลงบได้");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Filter (search name/username + balance range) then sort. Bad/blank range bounds are ignored.
  const min = minBudget.trim() === "" ? null : Number(minBudget);
  const max = maxBudget.trim() === "" ? null : Number(maxBudget);
  const q = query.trim().toLowerCase();
  const sorted = rows
    ? [...rows]
        .filter((r) => {
          if (q && !r.fullName.toLowerCase().includes(q) && !(r.username ?? "").toLowerCase().includes(q))
            return false;
          if (min != null && !Number.isNaN(min) && r.budget < min) return false;
          if (max != null && !Number.isNaN(max) && r.budget > max) return false;
          return true;
        })
        .sort((a, b) => (order === "asc" ? a.budget - b.budget : b.budget - a.budget))
    : [];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === sorted.length ? new Set() : new Set(sorted.map((r) => r.id)),
    );
  }

  async function doTopup(amount: number, reason: string) {
    const target = topupTarget;
    if (!target) return;
    setBusy(true);
    try {
      if (target.bulk) {
        const ids = [...selected];
        await topupStaffBudgetBulk({ user_ids: ids, amount, reason });
        toast.success(`เติมงบ +${amount} ให้ ${ids.length} คนแล้ว`);
        setSelected(new Set());
      } else if (target.row) {
        const res = await topupStaffBudget(target.row.id, { amount, reason });
        toast.success(`เติมงบ +${amount} ให้ ${target.row.fullName} แล้ว (คงเหลือ ${res.budget})`);
      }
      setTopupTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "เติมงบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">งบแต้มสตาฟ</h1>
          <p className="text-sm text-muted-foreground">
            เรียงงบน้อย→มาก เพื่อเห็นคนใกล้หมดก่อน · งบ &lt;10 จะขึ้นสีส้ม
          </p>
        </div>
        {selected.size > 0 ? (
          <Button onClick={() => setTopupTarget({ row: null, bulk: true })}>
            เติมงบที่เลือก ({selected.size})
          </Button>
        ) : null}
      </div>

      {/* Filter/sort toolbar — search by name/username, balance range, sort order. All client-side. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label className="mb-1 block text-xs text-muted-foreground">ค้นหา (ชื่อ / ชื่อผู้ใช้)</label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="พิมพ์ชื่อหรือ @username…"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">งบขั้นต่ำ</label>
          <Input
            type="number"
            inputMode="numeric"
            value={minBudget}
            onChange={(e) => setMinBudget(e.target.value)}
            placeholder="ต่ำสุด"
            className="w-28"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">งบสูงสุด</label>
          <Input
            type="number"
            inputMode="numeric"
            value={maxBudget}
            onChange={(e) => setMaxBudget(e.target.value)}
            placeholder="สูงสุด"
            className="w-28"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}
          className="gap-1"
        >
          งบ {order === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
        </Button>
        {(query || minBudget || maxBudget) && (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setMinBudget("");
              setMaxBudget("");
            }}
          >
            ล้างตัวกรอง
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          {rows === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? "ไม่มีเจ้าหน้าที่เช็คอิน" : "ไม่พบผลลัพธ์ที่ตรงกับตัวกรอง"}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === sorted.length && sorted.length > 0}
                      onChange={toggleAll}
                      className="size-4 rounded border-input accent-primary"
                      aria-label="เลือกทั้งหมด"
                    />
                  </TableHead>
                  <TableHead>ชื่อ</TableHead>
                  <TableHead>สถานะ</TableHead>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      aria-label="เรียงตามงบ"
                    >
                      งบคงเหลือ
                      {order === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">การกระทำ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.id} className={r.lowBudget ? "bg-amber-50" : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="size-4 rounded border-input accent-primary"
                        aria-label={`เลือก ${r.fullName}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/admin/staff/${r.id}/budget`} className="font-medium hover:underline">
                        {r.fullName}
                      </Link>
                      {r.username ? (
                        <span className="ml-2 text-xs text-muted-foreground">@{r.username}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {r.status === "active" ? (
                        <Badge className="border-transparent bg-green-100 text-green-800">ใช้งานอยู่</Badge>
                      ) : (
                        <Badge className="border-transparent bg-zinc-200 text-zinc-700">ปิดใช้งาน</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          r.lowBudget ? "font-semibold text-amber-700 tabular-nums" : "font-semibold tabular-nums"
                        }
                      >
                        {r.budget}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setTopupTarget({ row: r, bulk: false })}
                        >
                          เติม
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/staff/${r.id}/budget`}>รายละเอียด</Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TopupDialog
        open={topupTarget !== null}
        onOpenChange={(o) => !o && setTopupTarget(null)}
        title={
          topupTarget?.bulk
            ? `เติมงบให้ ${selected.size} คน`
            : `เติมงบ — ${topupTarget?.row?.fullName ?? ""}`
        }
        pending={busy}
        onConfirm={doTopup}
      />
    </div>
  );
}
