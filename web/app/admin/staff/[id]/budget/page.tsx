"use client";

// Admin > per-staff budget DETAIL (plan §4.7/§14). Gauge + preset topup + signed adjust (warns on
// would-go-negative) + full budget ledger + active grant tokens + link to per-head grants.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getStaffBudget, adjustStaffBudget, topupStaffBudget } from "@/lib/points-api";
import type { StaffBudgetDetailResponse } from "@/lib/points-types";
import { budgetReasonLabel } from "@/lib/labels";
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
import { BudgetGauge } from "@/components/points/budget-gauge";
import { TopupDialog } from "@/components/points/topup-dialog";
import { ReasonDialog } from "@/components/admin-tools/reason-dialog";

export default function StaffBudgetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<StaffBudgetDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustDelta, setAdjustDelta] = useState(""); // signed string for the adjust input
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getStaffBudget(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดข้อมูลงบได้");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doTopup(amount: number, reason: string) {
    setBusy(true);
    try {
      const res = await topupStaffBudget(id, { amount, reason });
      toast.success(`เติมงบ +${amount} แล้ว (คงเหลือ ${res.budget})`);
      setTopupOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "เติมงบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  // Signed adjust (admin_adjust) — delta entered separately, reason captured by the dialog.
  async function doAdjust(reason: string) {
    const delta = Number(adjustDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error("กรอกจำนวนที่ต้องการปรับ (บวกหรือลบ)");
      return;
    }
    setBusy(true);
    try {
      const res = await adjustStaffBudget(id, { delta, reason });
      toast.success(`ปรับงบ ${delta > 0 ? "+" : ""}${delta} แล้ว (คงเหลือ ${res.budget})`);
      setAdjustOpen(false);
      setAdjustDelta("");
      await load();
    } catch (e) {
      // would_go_negative bubbles up here as an ApiError.
      toast.error(e instanceof ApiError ? e.message : "ปรับงบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Quick summary: how much was given out (negative ledger lines: grant_issue + manual_grant).
  const issued = data.ledger
    .filter((r) => r.reason_code === "grant_issue" || r.reason_code === "manual_grant")
    .reduce((s, r) => s + Math.abs(r.delta), 0);
  const refunded = data.ledger
    .filter((r) => r.reason_code === "grant_refund")
    .reduce((s, r) => s + r.delta, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/staff/budget">
            <ArrowLeft className="size-4" /> ย้อนกลับ
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">งบแต้มของสตาฟ</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <BudgetGauge budget={data.budget} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">สรุปการแจก</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              แจกไปแล้ว <span className="font-semibold tabular-nums">{issued}</span> แต้ม
            </p>
            <p>
              คืนงบ <span className="font-semibold tabular-nums">{refunded}</span> แต้ม
            </p>
            <Button variant="link" className="h-auto p-0" asChild>
              <Link href={`/admin/staff/${id}/grants`}>ดูว่าแจกให้ใครบ้าง →</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setTopupOpen(true)}>เติมงบ</Button>
        <Button variant="outline" onClick={() => setAdjustOpen(true)}>
          ปรับ/ลดงบ
        </Button>
      </div>

      {/* Active grant tokens this staff issued (claim progress). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">QR แต้มที่ยังใช้งานอยู่</CardTitle>
        </CardHeader>
        <CardContent>
          {data.activeTokens.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">ไม่มี QR ที่ใช้งานอยู่</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>แต้ม/สิทธิ์</TableHead>
                  <TableHead>เคลมแล้ว</TableHead>
                  <TableHead>สร้างเมื่อ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.activeTokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="tabular-nums">{t.pointsValue}</TableCell>
                    <TableCell className="tabular-nums">
                      {t.claimsUsed} / {t.maxClaims}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatBangkok(t.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Full budget ledger (append-only). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ประวัติงบ</CardTitle>
        </CardHeader>
        <CardContent>
          {data.ledger.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">ยังไม่มีประวัติ</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>รายการ</TableHead>
                  <TableHead>จำนวน</TableHead>
                  <TableHead>เหตุผล</TableHead>
                  <TableHead>เวลา</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.ledger.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{budgetReasonLabel(r.reason_code)}</TableCell>
                    <TableCell>
                      <span
                        className={
                          r.delta >= 0
                            ? "font-semibold text-green-600 tabular-nums"
                            : "font-semibold text-red-600 tabular-nums"
                        }
                      >
                        {r.delta >= 0 ? "+" : ""}
                        {r.delta}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {r.reason ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatBangkok(r.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TopupDialog
        open={topupOpen}
        onOpenChange={setTopupOpen}
        title="เติมงบให้สตาฟ"
        pending={busy}
        onConfirm={doTopup}
      />

      {/* Signed adjust — delta input lives inside the reason dialog via children. */}
      <ReasonDialog
        open={adjustOpen}
        onOpenChange={(o) => {
          if (!o) setAdjustDelta("");
          setAdjustOpen(o);
        }}
        title="ปรับ/ลดงบ"
        description="ปรับงบแบบมีเครื่องหมาย (บวก = เพิ่ม, ลบ = ลด) สำหรับแก้ไขข้อผิดพลาด — ปรับให้ติดลบไม่ได้"
        confirmLabel="ปรับงบ"
        pending={busy}
        onConfirm={doAdjust}
      >
        <div className="space-y-1.5">
          <Label htmlFor="adjust-delta">จำนวนที่ปรับ (ใส่ - เพื่อลด)</Label>
          <Input
            id="adjust-delta"
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
