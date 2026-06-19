"use client";

// Admin > student points ledger + corrections (plan §4.6/§4.8). Ledger-first: never edits a number,
// only appends reverse/correct entries. Per-row reverse (reason-gated), a freeform correct (+/−),
// and a manual give/deduct (adjustPoints; admin unlimited). All sensitive actions require a reason.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  getAdminUserPoints,
  reverseUserPoint,
  correctUserPoint,
  adjustPoints,
} from "@/lib/points-api";
import type { LedgerEntry, WalletResponse } from "@/lib/points-types";
import { pointReasonLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ReasonDialog } from "@/components/admin-tools/reason-dialog";
import { DeltaPill } from "@/components/student/points-bits";

export default function AdminUserPointsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Per-row reverse target (the entry being reversed).
  const [reverseTarget, setReverseTarget] = useState<LedgerEntry | null>(null);
  // Freeform correct dialog + its signed delta input.
  const [correctOpen, setCorrectOpen] = useState(false);
  const [correctDelta, setCorrectDelta] = useState("");
  // Manual give/deduct dialog + its signed delta input.
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustDelta, setAdjustDelta] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getAdminUserPoints(id, { limit: 200 }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดประวัติแต้มได้");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A ledger row is "reversed" when another row points back to it via reversal_of_ledger_id.
  const reversedIds = new Set(
    (data?.history ?? []).map((r) => r.reversal_of_ledger_id).filter(Boolean) as string[],
  );

  async function doReverse(reason: string) {
    if (!reverseTarget) return;
    setBusy(true);
    try {
      const res = await reverseUserPoint(id, { ledger_id: reverseTarget.id, reason });
      if (res.result === "reversed") {
        toast.success("ถอนรายการแล้ว");
      } else {
        toast.error(res.result); // already_reversed / ledger_not_found / points_closed (admin bypass usually)
      }
      setReverseTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ถอนรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function doCorrect(reason: string) {
    const delta = Number(correctDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error("กรอกจำนวนที่ต้องการปรับ (บวกหรือลบ)");
      return;
    }
    setBusy(true);
    try {
      const res = await correctUserPoint(id, { delta, reason });
      if (res.result === "corrected") toast.success("เพิ่มรายการปรับแก้แล้ว");
      else toast.error(res.result);
      setCorrectOpen(false);
      setCorrectDelta("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ปรับแก้ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function doAdjust(reason: string) {
    const delta = Number(adjustDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error("กรอกจำนวนแต้ม (บวก = ให้, ลบ = หัก)");
      return;
    }
    setBusy(true);
    try {
      const res = await adjustPoints({ user_id: id, delta, reason });
      if (res.result === "adjusted") toast.success("ปรับแต้มแล้ว");
      else toast.error(res.result);
      setAdjustOpen(false);
      setAdjustDelta("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ปรับแต้มไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/users/${id}`}>
              <ArrowLeft className="size-4" /> ย้อนกลับ
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">แต้มของนักศึกษา</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setAdjustOpen(true)}>
            ให้/หักแต้ม
          </Button>
          <Button variant="outline" onClick={() => setCorrectOpen(true)}>
            ปรับแก้ (correction)
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-normal text-muted-foreground">แต้มรวม</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-3xl font-bold tabular-nums">{data.balance}</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ประวัติแต้ม (append-only)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">ยังไม่มีประวัติแต้ม</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>รายการ</TableHead>
                  <TableHead>แต้ม</TableHead>
                  <TableHead>เหตุผล</TableHead>
                  <TableHead>เวลา</TableHead>
                  <TableHead className="text-right">การกระทำ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.history.map((r) => {
                  const isReversed = reversedIds.has(r.id);
                  // A reversal entry itself shouldn't be reverse-able again.
                  const isReversalEntry = r.reason_code === "correction_reverse";
                  // The wallet ledger row carries an optional human reason inside metadata.reason.
                  const reasonText =
                    typeof r.metadata?.reason === "string" ? (r.metadata.reason as string) : null;
                  return (
                    <TableRow key={r.id} className={isReversed ? "opacity-60" : undefined}>
                      <TableCell className={isReversed ? "line-through" : undefined}>
                        {pointReasonLabel(r.reason_code)}
                        {isReversed ? (
                          <Badge className="ml-2 border-transparent bg-amber-100 text-amber-900">
                            ปรับแก้แล้ว
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <DeltaPill delta={r.delta} />
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {reasonText ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatBangkok(r.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {!isReversed && !isReversalEntry ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setReverseTarget(r)}
                          >
                            <RotateCcw className="size-4" /> ถอน
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Reverse a specific entry (reason-gated). */}
      <ReasonDialog
        open={reverseTarget !== null}
        onOpenChange={(o) => !o && setReverseTarget(null)}
        title="ถอนรายการแต้ม"
        description="ลงรายการชดเชย (ติดลบ) เพื่อถอนแต้มของรายการนี้ — รายการเดิมจะถูกทำเครื่องหมายว่าปรับแก้แล้ว"
        confirmLabel="ถอนรายการ"
        destructive
        pending={busy}
        onConfirm={doReverse}
      />

      {/* Freeform correction (+/−). */}
      <ReasonDialog
        open={correctOpen}
        onOpenChange={(o) => {
          if (!o) setCorrectDelta("");
          setCorrectOpen(o);
        }}
        title="ปรับแก้แต้ม (correction)"
        description="เติม/ลดแต้มที่ระบบพลาด (ลงรายการ correction_add) — ไม่ผูกกับรายการเดิม"
        confirmLabel="ปรับแก้"
        pending={busy}
        onConfirm={doCorrect}
      >
        <div className="space-y-1.5">
          <Label htmlFor="correct-delta">จำนวนที่ปรับ (ใส่ - เพื่อลด)</Label>
          <Input
            id="correct-delta"
            type="number"
            inputMode="numeric"
            value={correctDelta}
            onChange={(e) => setCorrectDelta(e.target.value)}
            placeholder="เช่น 20 หรือ -10"
          />
        </div>
      </ReasonDialog>

      {/* Manual give/deduct (adjustPoints). Admin = unlimited +/−. */}
      <ReasonDialog
        open={adjustOpen}
        onOpenChange={(o) => {
          if (!o) setAdjustDelta("");
          setAdjustOpen(o);
        }}
        title="ให้/หักแต้มด้วยตนเอง"
        description="ปรับแต้มนักศึกษาโดยตรง (บวก = ให้, ลบ = หัก)"
        confirmLabel="ปรับแต้ม"
        pending={busy}
        onConfirm={doAdjust}
      >
        <div className="space-y-1.5">
          <Label htmlFor="adjust-points">จำนวนแต้ม (ใส่ - เพื่อหัก)</Label>
          <Input
            id="adjust-points"
            type="number"
            inputMode="numeric"
            value={adjustDelta}
            onChange={(e) => setAdjustDelta(e.target.value)}
            placeholder="เช่น 50 หรือ -20"
          />
        </div>
      </ReasonDialog>
    </div>
  );
}
