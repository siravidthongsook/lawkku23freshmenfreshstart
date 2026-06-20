"use client";

// My check-in/out history for one event — the CURRENT staff's own actions, audit-backed so it survives
// reload (unlike the in-memory recent-scans strip). Lets staff find + undo their own mistakes here.
// Undo reuses the same undo-checkin/undo-checkout endpoints (reason required) as manual-search.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Undo2, CheckCircle2, LogOut, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { reasonSchema } from "@/lib/schemas";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { auditActionLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import type { MyHistoryItem, MyHistoryResponse } from "./types";

// IN-family actions get a check icon, OUT-family a logout icon (undo rows reuse the family icon, dimmed).
function isOutAction(a: MyHistoryItem["action"]): boolean {
  return a === "qr_scan_checkout" || a === "manual_checkout" || a === "manual_checkout_undo";
}

// What an undo on THIS row reverses + which endpoint to call. null = nothing reversible right now.
function undoFor(it: MyHistoryItem): { endpoint: "undo-checkin" | "undo-checkout"; verb: string } | null {
  if (it.canUndoCheckin) return { endpoint: "undo-checkin", verb: "เช็คอิน" };
  if (it.canUndoCheckout) return { endpoint: "undo-checkout", verb: "เช็คเอาท์" };
  return null;
}

export function MyHistory({ eventId, onChanged }: { eventId: string; onChanged?: () => void }) {
  const [items, setItems] = useState<MyHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Undo dialog state (reason mandatory — audit contract).
  const [undoTarget, setUndoTarget] = useState<MyHistoryItem | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [undoBusy, setUndoBusy] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiGet<MyHistoryResponse>(`/staff/events/${eventId}/my-history`);
      setItems(res.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดประวัติได้");
    } finally {
      setRefreshing(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitUndo() {
    if (!undoTarget?.registrationId) return;
    const action = undoFor(undoTarget);
    if (!action) return;
    const parsed = reasonSchema.safeParse({ reason: undoReason.trim() });
    if (!parsed.success) {
      toast.error("ต้องระบุเหตุผลในการยกเลิก");
      return;
    }
    setUndoBusy(true);
    try {
      await apiPost(`/registrations/${undoTarget.registrationId}/${action.endpoint}`, {
        reason: parsed.data.reason,
      });
      toast.success(`ยกเลิกการ${action.verb}ของ ${undoTarget.fullName ?? "ผู้ใช้"} แล้ว`);
      setUndoTarget(null);
      setUndoReason("");
      onChanged?.(); // refresh parent counts
      void load(); // refresh history (the undone row loses its button, an undo row appears)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ยกเลิกไม่สำเร็จ";
      toast.error(msg);
    } finally {
      setUndoBusy(false);
    }
  }

  let body;
  if (items === null && !error) {
    body = (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (error) {
    body = (
      <Card className="p-4 text-center text-sm text-muted-foreground">
        {error}
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            ลองใหม่
          </Button>
        </div>
      </Card>
    );
  } else if (!items || items.length === 0) {
    body = (
      <p className="py-6 text-center text-sm text-muted-foreground">
        ยังไม่มีประวัติการเช็คชื่อของคุณในกิจกรรมนี้
      </p>
    );
  } else {
    body = (
      <div className="space-y-2">
        {items.map((it) => {
          const undo = undoFor(it);
          const Icon = isOutAction(it.action) ? LogOut : CheckCircle2;
          return (
            <Card key={it.id} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{it.fullName ?? "ไม่ทราบชื่อ"}</span>
                    {it.studentId && (
                      <span className="font-mono text-xs text-muted-foreground">{it.studentId}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {auditActionLabel(it.action)} · {formatBangkok(it.at)}
                    {it.pointsAwarded ? ` · +${it.pointsAwarded}` : ""}
                  </p>
                </div>
                {undo && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 shrink-0"
                    onClick={() => {
                      setUndoTarget(it);
                      setUndoReason("");
                    }}
                  >
                    <Undo2 className="size-4" /> ยกเลิก
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  const undo = undoTarget ? undoFor(undoTarget) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">การเช็คชื่อของคุณในกิจกรรมนี้</p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} /> รีเฟรช
        </Button>
      </div>

      {body}

      {/* Undo reason dialog — reason mandatory (audit). */}
      <Dialog open={undoTarget !== null} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยกเลิกการ{undo?.verb ?? "เช็คชื่อ"}</DialogTitle>
            <DialogDescription>
              ยกเลิกการ{undo?.verb}ของ {undoTarget?.fullName ?? "ผู้ใช้"} · ต้องระบุเหตุผล และจะถูกบันทึกไว้ในบันทึกการตรวจสอบ
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="hist-undo-reason">เหตุผล</Label>
            <Textarea
              id="hist-undo-reason"
              value={undoReason}
              onChange={(e) => setUndoReason(e.target.value)}
              placeholder={`เหตุใดจึงยกเลิกการ${undo?.verb ?? "เช็คชื่อ"}นี้?`}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUndoTarget(null)} disabled={undoBusy}>
              ปิด
            </Button>
            <Button onClick={submitUndo} disabled={undoBusy || !undoReason.trim()}>
              {undoBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> กำลังยกเลิก…
                </>
              ) : (
                "ยืนยันยกเลิก"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
