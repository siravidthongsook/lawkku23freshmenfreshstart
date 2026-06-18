"use client";

// Within-event manual search + manual check-in / undo check-in. Minimal info only (no email/phone/answers).
// Undo requires a reason (prompted via dialog) per the audit-log contract.
import { useState } from "react";
import { Search, UserCheck, Undo2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { reasonSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RegistrationStatusBadge } from "@/components/badges";
import { regStatusLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import type {
  CheckinSearchResponse,
  CheckinSearchResult,
  ManualCheckinResponse,
} from "./types";

export function ManualSearch({
  eventId,
  onCheckedIn,
}: {
  eventId: string;
  // Notify parent so it can refresh counts after a manual check-in / undo.
  onCheckedIn?: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CheckinSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Confirm-before-check-in target (same-name / missing student_id risk — staff must eyeball identity first).
  const [confirmTarget, setConfirmTarget] = useState<CheckinSearchResult | null>(null);

  // Undo dialog state.
  const [undoTarget, setUndoTarget] = useState<CheckinSearchResult | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [undoBusy, setUndoBusy] = useState(false);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    try {
      const res = await apiGet<CheckinSearchResponse>(
        `/events/${eventId}/checkins/search?q=${encodeURIComponent(query)}`,
      );
      setResults(res.results ?? []);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ค้นหาไม่สำเร็จ";
      toast.error(msg);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function manualCheckin(r: CheckinSearchResult) {
    setBusyId(r.registrationId);
    try {
      const res = await apiPost<ManualCheckinResponse>(
        `/registrations/${r.registrationId}/manual-checkin`,
      );
      toast.success(`เช็คอิน ${r.fullName} แล้ว`);
      // Reflect new status locally without a re-search. Use the AUTHORITATIVE server time (:73), not new Date().
      setResults((prev) =>
        prev?.map((x) =>
          x.registrationId === r.registrationId
            ? { ...x, status: "checked_in", checkedInAt: res.checkedInAt }
            : x,
        ) ?? null,
      );
      onCheckedIn?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "เช็คอินไม่สำเร็จ";
      toast.error(msg);
      throw err; // let ConfirmDialog keep itself open so staff can retry
    } finally {
      setBusyId(null);
    }
  }

  async function submitUndo() {
    if (!undoTarget) return;
    const parsed = reasonSchema.safeParse({ reason: undoReason.trim() });
    if (!parsed.success) {
      toast.error("ต้องระบุเหตุผลในการยกเลิกการเช็คอิน");
      return;
    }
    setUndoBusy(true);
    try {
      await apiPost(`/registrations/${undoTarget.registrationId}/undo-checkin`, {
        reason: parsed.data.reason,
      });
      toast.success(`ยกเลิกการเช็คอินของ ${undoTarget.fullName} แล้ว`);
      setResults((prev) =>
        prev?.map((x) =>
          x.registrationId === undoTarget.registrationId
            ? { ...x, status: "registered", checkedInAt: null }
            : x,
        ) ?? null,
      );
      onCheckedIn?.();
      setUndoTarget(null);
      setUndoReason("");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ยกเลิกไม่สำเร็จ";
      toast.error(msg);
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={runSearch} className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหาด้วยรหัสนักศึกษา ชื่อ คณะ หรือสาขา"
          className="h-12 text-base"
          autoComplete="off"
        />
        <Button type="submit" disabled={searching || !q.trim()} className="h-12">
          <Search className="size-5" /> ค้นหา
        </Button>
      </form>

      {/* List spinner during a slow search — prior results stay dimmed so staff know a refresh is in flight (:45). */}
      {searching && (
        <p className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> กำลังค้นหา…
        </p>
      )}

      {!searching && results !== null && results.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          ไม่พบการลงทะเบียนที่ตรงกันในกิจกรรมนี้
        </p>
      )}

      <div className={searching ? "space-y-2 opacity-50" : "space-y-2"}>
        {results?.map((r) => (
          <Card key={r.registrationId} className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.fullName}</span>
                  <RegistrationStatusBadge status={r.status} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {r.studentId ?? "—"}
                  {(r.faculty || r.department) &&
                    ` · ${[r.faculty, r.department].filter(Boolean).join(" / ")}`}
                </p>
                {r.status === "checked_in" && r.checkedInAt && (
                  <p className="text-xs text-muted-foreground">
                    เช็คอินแล้ว {formatBangkok(r.checkedInAt)}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                {r.status === "checked_in" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10"
                    onClick={() => {
                      setUndoTarget(r);
                      setUndoReason("");
                    }}
                  >
                    <Undo2 className="size-4" /> ยกเลิก
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-10"
                    disabled={
                      busyId === r.registrationId ||
                      r.status === "cancelled" ||
                      r.status === "waitlisted"
                    }
                    onClick={() => setConfirmTarget(r)}
                  >
                    <UserCheck className="size-4" />
                    {busyId === r.registrationId ? "กำลังเช็คอิน…" : "เช็คอิน"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Confirm-before-check-in: show full identity so staff don't check in the wrong same-name person (:172). */}
      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title="ยืนยันการเช็คอิน"
        description={
          confirmTarget
            ? `ยืนยันเช็คอิน: ${confirmTarget.fullName} · รหัสนักศึกษา ${
                confirmTarget.studentId ?? "ไม่มี"
              }${
                confirmTarget.faculty || confirmTarget.department
                  ? ` · ${[confirmTarget.faculty, confirmTarget.department].filter(Boolean).join(" / ")}`
                  : ""
              } · สถานะ ${regStatusLabel(confirmTarget.status)}`
            : undefined
        }
        confirmLabel="เช็คอิน"
        onConfirm={async () => {
          if (confirmTarget) await manualCheckin(confirmTarget);
        }}
      />

      {/* Undo reason dialog — reason is mandatory (audit). */}
      <Dialog open={undoTarget !== null} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยกเลิกการเช็คอิน</DialogTitle>
            <DialogDescription>
              {undoTarget ? `เปลี่ยนสถานะ ${undoTarget.fullName} กลับเป็นลงทะเบียนแล้ว` : ""} ต้องระบุเหตุผล
              และจะถูกบันทึกไว้ในบันทึกการตรวจสอบ
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="undo-reason">เหตุผล</Label>
            <Textarea
              id="undo-reason"
              value={undoReason}
              onChange={(e) => setUndoReason(e.target.value)}
              placeholder="เหตุใดจึงยกเลิกการเช็คอินนี้?"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUndoTarget(null)} disabled={undoBusy}>
              ยกเลิก
            </Button>
            <Button onClick={submitUndo} disabled={undoBusy || !undoReason.trim()}>
              {undoBusy ? "กำลังยกเลิก…" : "ยกเลิกการเช็คอิน"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
