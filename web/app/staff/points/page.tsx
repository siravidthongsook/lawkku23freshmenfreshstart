"use client";

// Staff (+admin) self-service points (plan §4.4/§4.6/§4.8/§14):
//  - own budget gauge (getMyBudget)
//  - generate a grant QR (issueGrantToken) → plaintext rendered as a QR EXACTLY ONCE (warned)
//  - revoke a token (refunds unclaimed seats)
//  - manual give to a student (adjustPoints, +only for staff) by user id
//  - self-reverse a recent manual grant within the window (reverseOwnGrant)
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { AlertTriangle, RotateCcw, Copy } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  getMyBudget,
  issueGrantToken,
  revokeGrantToken,
  getGrantTokenQr,
  adjustPoints,
  reverseOwnGrant,
} from "@/lib/points-api";
import type { StaffBudgetResponse } from "@/lib/points-types";

// Minimal shape the QR dialog needs — satisfied by both issue + re-display responses.
type GrantQrView = { token: string; pointsValue: number; maxClaims: number };
import { budgetReasonLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { copyText } from "@/lib/clipboard";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReasonDialog } from "@/components/admin-tools/reason-dialog";
import { BudgetGauge } from "@/components/points/budget-gauge";
import { GrantTokenForm } from "@/components/points/grant-token-form";
import { StudentPicker } from "@/components/points/student-picker";

const STAFF_ROLES = ["checkin_staff", "admin"] as const;

// === Grant QR reveal — re-displayable from the list below until scanned/exhausted/revoked. ===
function GrantQrDialog({ grant, onClose }: { grant: GrantQrView; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>QR แต้ม ({grant.pointsValue} แต้ม × {grant.maxClaims} สิทธิ์)</DialogTitle>
          <DialogDescription className="flex items-start gap-2 text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            ให้น้องสแกน QR นี้ — ปิดแล้วเปิดดูซ้ำได้จากรายการ “QR ที่สร้างไว้” ด้านล่าง
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg bg-white p-4">
            <QRCodeSVG value={grant.token} size={224} level="M" aria-label="คิวอาร์โค้ดแต้ม" />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyText(grant.token, { successMsg: "คัดลอกโทเค็นแล้ว" })}
          >
            <Copy className="size-4" /> คัดลอกโทเค็น
          </Button>
          <Button className="w-full" onClick={onClose}>
            เสร็จสิ้น
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StaffPointsInner() {
  const [data, setData] = useState<StaffBudgetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Grant QR currently shown (from a fresh issue or a re-display).
  const [grantQr, setGrantQr] = useState<GrantQrView | null>(null);
  // Token pending revoke (reason-gated); holds the grant_token_id.
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  // Ledger entry pending self-reverse (a manual grant within the window).
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);

  // Manual give to a student (picked via the staff student-search typeahead; id feeds adjustPoints).
  const [manualUserId, setManualUserId] = useState("");
  const [manualDelta, setManualDelta] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getMyBudget());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดงบได้");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function doIssue(value: number, claims: number) {
    setBusy(true);
    try {
      const res = await issueGrantToken({ points_value: value, max_claims: claims });
      // reused = an identical unscanned QR already existed → re-shown, no budget spent.
      if (res.reused) toast.info("ใช้ QR เดิมที่ยังไม่ถูกสแกน (ไม่หักงบเพิ่ม)");
      setGrantQr(res);
      await load();
    } catch (e) {
      // insufficient_budget bubbles up here.
      toast.error(e instanceof ApiError ? e.message : "สร้าง QR ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  // Re-display an existing active QR (no new token, no debit).
  async function doShowQr(tokenId: string) {
    setBusy(true);
    try {
      setGrantQr(await getGrantTokenQr(tokenId));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "เปิด QR ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke(reason: string) {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      const res = await revokeGrantToken(revokeTarget, reason);
      if (res.result === "revoked") toast.success("ยกเลิก QR และคืนงบสิทธิ์ที่เหลือแล้ว");
      else toast.error(res.result);
      setRevokeTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ยกเลิกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function doSelfReverse(reason: string) {
    if (!reverseTarget) return;
    setBusy(true);
    try {
      const res = await reverseOwnGrant(reverseTarget, reason);
      if (res.result === "reversed") toast.success("ถอนแต้มที่แจกและคืนงบแล้ว");
      else toast.error(res.result); // not_your_grant / reverse_window_expired / already_reversed …
      setReverseTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ถอนไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function doManualGive(reason: string) {
    const delta = Number(manualDelta);
    if (!manualUserId.trim()) {
      toast.error("เลือกนักศึกษาก่อน");
      return;
    }
    if (!Number.isInteger(delta) || delta <= 0) {
      toast.error("จำนวนแต้มต้องมากกว่า 0 (สตาฟให้แต้มได้เท่านั้น)");
      return;
    }
    setBusy(true);
    try {
      const res = await adjustPoints({ user_id: manualUserId.trim(), delta, reason });
      if (res.result === "adjusted") toast.success("ให้แต้มนักศึกษาแล้ว");
      else toast.error(res.result); // insufficient_budget / not_student …
      setManualOpen(false);
      setManualUserId("");
      setManualDelta("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ให้แต้มไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Active grant tokens surfaced from the budget ledger (grant_issue rows carry the token id).
  // Show only still-active tokens — revoked/exhausted ones drop off (older backend lacks the flag →
  // default to showing, so behaviour degrades gracefully rather than hiding everything).
  const issuedTokens = data.history.filter(
    (r) => r.reason_code === "grant_issue" && r.grant_token_id && r.grant_token_active !== false,
  );
  // Recent manual grants the staff member can self-reverse (within the window the server enforces).
  const manualGrants = data.history.filter((r) => r.reason_code === "manual_grant");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">แจกแต้ม</h1>

      <BudgetGauge budget={data.budget} />

      <GrantTokenForm budget={data.budget} pending={busy} onSubmit={doIssue} />

      {/* Manual give to a student (+only for staff). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ให้แต้มด้วยตนเอง</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => setManualOpen(true)}>
            ให้แต้มนักศึกษา (หักงบ)
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            สตาฟให้แต้มได้เท่านั้น (บวก) และหักจากงบ — การลบแต้มเป็นสิทธิ์ของผู้ดูแล
          </p>
        </CardContent>
      </Card>

      {/* Active grant tokens (revocable). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">QR ที่สร้างไว้</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {issuedTokens.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">ยังไม่ได้สร้าง QR</p>
          ) : (
            issuedTokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium">หักงบ {Math.abs(t.delta)} แต้ม</p>
                  <p className="text-xs text-muted-foreground">{formatBangkok(t.created_at)}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void doShowQr(t.grant_token_id!)}
                  >
                    ดู QR
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(t.grant_token_id)}
                  >
                    ยกเลิก (คืนงบ)
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Recent manual grants — self-reverse within the window. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">แต้มที่แจกมือล่าสุด</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {manualGrants.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">ยังไม่มี</p>
          ) : (
            manualGrants.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium">หักงบ {Math.abs(g.delta)} แต้ม</p>
                  <p className="text-xs text-muted-foreground">{formatBangkok(g.created_at)}</p>
                </div>
                {/* The related point-ledger id is needed to reverse; budget rows carry it when present.
                    Hide the button once reversed (else it lingers and a re-press → already_reversed). */}
                {g.reversed ? (
                  <span className="shrink-0 text-xs text-muted-foreground">ถอนแล้ว</span>
                ) : g.related_ledger_id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setReverseTarget(g.related_ledger_id ?? null)}
                  >
                    <RotateCcw className="size-4" /> ถอน
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        งบล่าสุดอัปเดตอัตโนมัติหลังทุกการกระทำ ·{" "}
        <button onClick={() => void load()} className="underline">
          รีเฟรช
        </button>
      </p>

      {grantQr ? <GrantQrDialog grant={grantQr} onClose={() => setGrantQr(null)} /> : null}

      <ReasonDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="ยกเลิก QR แต้ม"
        description="สิทธิ์ที่ยังไม่ถูกเคลมจะถูกคืนเข้างบของคุณ"
        confirmLabel="ยกเลิก QR"
        destructive
        pending={busy}
        onConfirm={doRevoke}
      />

      <ReasonDialog
        open={reverseTarget !== null}
        onOpenChange={(o) => !o && setReverseTarget(null)}
        title="ถอนแต้มที่แจก"
        description="ถอนแต้มที่คุณเพิ่งแจก (ภายในเวลาที่กำหนด) และคืนงบกลับเข้าบัญชีคุณ"
        confirmLabel="ถอน"
        destructive
        pending={busy}
        onConfirm={doSelfReverse}
      />

      <ReasonDialog
        open={manualOpen}
        onOpenChange={(o) => {
          if (!o) {
            setManualUserId("");
            setManualDelta("");
          }
          setManualOpen(o);
        }}
        title="ให้แต้มนักศึกษา"
        description="ให้แต้มโดยตรง (หักจากงบของคุณ)"
        confirmLabel="ให้แต้ม"
        pending={busy}
        onConfirm={doManualGive}
      >
        <div className="space-y-1.5">
          <Label>นักศึกษา</Label>
          {/* Typeahead → select a student; the chosen id feeds the adjustPoints call. */}
          <StudentPicker value={manualUserId} onChange={(id) => setManualUserId(id)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="manual-delta">จำนวนแต้ม (บวกเท่านั้น)</Label>
          <Input
            id="manual-delta"
            type="number"
            inputMode="numeric"
            min={1}
            value={manualDelta}
            onChange={(e) => setManualDelta(e.target.value)}
            placeholder="เช่น 10"
          />
        </div>
      </ReasonDialog>
    </div>
  );
}

export default function StaffPointsPage() {
  return (
    <RequireRole roles={[...STAFF_ROLES]}>
      <AppShell>
        <StaffPointsInner />
      </AppShell>
    </RequireRole>
  );
}
