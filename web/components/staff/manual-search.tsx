"use client";

// Within-event manual search + manual check-in/out + undo. Minimal info only (no email/phone/answers).
// `mode` switches the surface between check-IN and check-OUT (same search, different action + endpoints).
// Undo requires a reason (prompted via dialog) per the audit-log contract.
import { useState } from "react";
import { Search, UserCheck, UserMinus, Undo2, Loader2 } from "lucide-react";
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
  ManualCheckoutResponse,
} from "./types";

type Mode = "in" | "out";

// All mode-varying copy in one place so the JSX below stays direction-agnostic.
const COPY = {
  in: {
    actionLabel: "เช็คอิน",
    actioningLabel: "กำลังเช็คอิน…",
    confirmTitle: "ยืนยันการเช็คอิน",
    confirmVerb: "ยืนยันเช็คอิน",
    successVerb: "เช็คอิน",
    undoTitle: "ยกเลิกการเช็คอิน",
    undoSuccessVerb: "ยกเลิกการเช็คอิน",
    undoDesc: (name: string) => `เปลี่ยนสถานะ ${name} กลับเป็นลงทะเบียนแล้ว`,
    undoPlaceholder: "เหตุใดจึงยกเลิกการเช็คอินนี้?",
    undoRequired: "ต้องระบุเหตุผลในการยกเลิกการเช็คอิน",
  },
  out: {
    actionLabel: "เช็คเอาท์",
    actioningLabel: "กำลังเช็คเอาท์…",
    confirmTitle: "ยืนยันการเช็คเอาท์",
    confirmVerb: "ยืนยันเช็คเอาท์",
    successVerb: "เช็คเอาท์",
    undoTitle: "ยกเลิกการเช็คเอาท์",
    undoSuccessVerb: "ยกเลิกการเช็คเอาท์",
    undoDesc: (name: string) => `ลบสถานะเช็คเอาท์ของ ${name} (ยังคงสถานะเช็คอิน)`,
    undoPlaceholder: "เหตุใดจึงยกเลิกการเช็คเอาท์นี้?",
    undoRequired: "ต้องระบุเหตุผลในการยกเลิกการเช็คเอาท์",
  },
} as const;

export function ManualSearch({
  eventId,
  mode = "in",
  onChanged,
}: {
  eventId: string;
  mode?: Mode;
  // Notify parent so it can refresh counts after a manual action.
  onChanged?: () => void;
}) {
  const t = COPY[mode];
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CheckinSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Confirm-before-action target (same-name / missing student_id risk — staff must eyeball identity first).
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

  // Commit the manual action (check-in or check-out) for one registration.
  async function commitAction(r: CheckinSearchResult) {
    setBusyId(r.registrationId);
    try {
      if (mode === "in") {
        const res = await apiPost<ManualCheckinResponse>(
          `/registrations/${r.registrationId}/manual-checkin`,
        );
        // Reflect new status locally using the AUTHORITATIVE server time (not new Date()).
        setResults((prev) =>
          prev?.map((x) =>
            x.registrationId === r.registrationId
              ? { ...x, status: "checked_in", checkedInAt: res.checkedInAt }
              : x,
          ) ?? null,
        );
      } else {
        const res = await apiPost<ManualCheckoutResponse>(
          `/registrations/${r.registrationId}/manual-checkout`,
        );
        setResults((prev) =>
          prev?.map((x) =>
            x.registrationId === r.registrationId
              ? { ...x, checkedOutAt: res.checkedOutAt }
              : x,
          ) ?? null,
        );
      }
      toast.success(`${t.successVerb} ${r.fullName} แล้ว`);
      onChanged?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `${t.actionLabel}ไม่สำเร็จ`;
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
      toast.error(t.undoRequired);
      return;
    }
    setUndoBusy(true);
    try {
      const endpoint = mode === "in" ? "undo-checkin" : "undo-checkout";
      await apiPost(`/registrations/${undoTarget.registrationId}/${endpoint}`, {
        reason: parsed.data.reason,
      });
      toast.success(`${t.undoSuccessVerb}ของ ${undoTarget.fullName} แล้ว`);
      setResults((prev) =>
        prev?.map((x) =>
          x.registrationId === undoTarget.registrationId
            ? mode === "in"
              ? { ...x, status: "registered", checkedInAt: null, checkedOutAt: null }
              : { ...x, checkedOutAt: null }
            : x,
        ) ?? null,
      );
      onChanged?.();
      setUndoTarget(null);
      setUndoReason("");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "ยกเลิกไม่สำเร็จ";
      toast.error(msg);
    } finally {
      setUndoBusy(false);
    }
  }

  // Per-row action button. IN: check-in vs undo by status. OUT: check-out vs undo by checkedOutAt,
  // and "must check in first" when the person hasn't checked in yet.
  function RowAction({ r }: { r: CheckinSearchResult }) {
    if (mode === "in") {
      if (r.status === "checked_in") {
        return (
          <Button variant="outline" size="sm" className="h-10" onClick={() => { setUndoTarget(r); setUndoReason(""); }}>
            <Undo2 className="size-4" /> ยกเลิก
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          className="h-10"
          disabled={busyId === r.registrationId || r.status === "cancelled" || r.status === "waitlisted"}
          onClick={() => setConfirmTarget(r)}
        >
          <UserCheck className="size-4" />
          {busyId === r.registrationId ? t.actioningLabel : t.actionLabel}
        </Button>
      );
    }
    // mode === "out"
    if (r.checkedOutAt) {
      return (
        <Button variant="outline" size="sm" className="h-10" onClick={() => { setUndoTarget(r); setUndoReason(""); }}>
          <Undo2 className="size-4" /> ยกเลิก
        </Button>
      );
    }
    if (r.status !== "checked_in") {
      // Can't check out someone who never checked in — make that explicit instead of a dead button.
      return <span className="text-xs text-muted-foreground">ยังไม่ได้เช็คอิน</span>;
    }
    return (
      <Button
        size="sm"
        className="h-10"
        disabled={busyId === r.registrationId}
        onClick={() => setConfirmTarget(r)}
      >
        <UserMinus className="size-4" />
        {busyId === r.registrationId ? t.actioningLabel : t.actionLabel}
      </Button>
    );
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

      {/* List spinner during a slow search — prior results stay dimmed so staff know a refresh is in flight. */}
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
                {r.checkedOutAt && (
                  <p className="text-xs text-muted-foreground">
                    เช็คเอาท์แล้ว {formatBangkok(r.checkedOutAt)}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <RowAction r={r} />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Confirm-before-action: show full identity so staff don't action the wrong same-name person. */}
      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title={t.confirmTitle}
        description={
          confirmTarget
            ? `${t.confirmVerb}: ${confirmTarget.fullName} · รหัสนักศึกษา ${
                confirmTarget.studentId ?? "ไม่มี"
              }${
                confirmTarget.faculty || confirmTarget.department
                  ? ` · ${[confirmTarget.faculty, confirmTarget.department].filter(Boolean).join(" / ")}`
                  : ""
              } · สถานะ ${regStatusLabel(confirmTarget.status)}`
            : undefined
        }
        confirmLabel={t.actionLabel}
        onConfirm={async () => {
          if (confirmTarget) await commitAction(confirmTarget);
        }}
      />

      {/* Undo reason dialog — reason is mandatory (audit). */}
      <Dialog open={undoTarget !== null} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.undoTitle}</DialogTitle>
            <DialogDescription>
              {undoTarget ? t.undoDesc(undoTarget.fullName) : ""} ต้องระบุเหตุผล และจะถูกบันทึกไว้ในบันทึกการตรวจสอบ
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="undo-reason">เหตุผล</Label>
            <Textarea
              id="undo-reason"
              value={undoReason}
              onChange={(e) => setUndoReason(e.target.value)}
              placeholder={t.undoPlaceholder}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUndoTarget(null)} disabled={undoBusy}>
              ยกเลิก
            </Button>
            <Button onClick={submitUndo} disabled={undoBusy || !undoReason.trim()}>
              {undoBusy ? "กำลังยกเลิก…" : t.undoTitle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
