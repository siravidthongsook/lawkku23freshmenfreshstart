"use client";

// Within-event manual search + manual check-in / undo check-in. Minimal info only (no email/phone/answers).
// Undo requires a reason (prompted via dialog) per the audit-log contract.
import { useState } from "react";
import { Search, UserCheck, Undo2 } from "lucide-react";
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
import { RegistrationStatusBadge } from "@/components/badges";
import { formatBangkok } from "@/lib/time";
import type { CheckinSearchResponse, CheckinSearchResult } from "./types";

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
      const msg = err instanceof ApiError ? err.message : "Search failed";
      toast.error(msg);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function manualCheckin(r: CheckinSearchResult) {
    setBusyId(r.registrationId);
    try {
      await apiPost(`/registrations/${r.registrationId}/manual-checkin`);
      toast.success(`Checked in ${r.fullName}`);
      // Reflect new status locally without a re-search.
      setResults((prev) =>
        prev?.map((x) =>
          x.registrationId === r.registrationId
            ? { ...x, status: "checked_in", checkedInAt: new Date().toISOString() }
            : x,
        ) ?? null,
      );
      onCheckedIn?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Check-in failed";
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  async function submitUndo() {
    if (!undoTarget) return;
    const parsed = reasonSchema.safeParse({ reason: undoReason.trim() });
    if (!parsed.success) {
      toast.error("A reason is required to undo a check-in.");
      return;
    }
    setUndoBusy(true);
    try {
      await apiPost(`/registrations/${undoTarget.registrationId}/undo-checkin`, {
        reason: parsed.data.reason,
      });
      toast.success(`Undid check-in for ${undoTarget.fullName}`);
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
      const msg = err instanceof ApiError ? err.message : "Undo failed";
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
          placeholder="Search by student ID, name, faculty, department"
          className="h-12 text-base"
          autoComplete="off"
        />
        <Button type="submit" disabled={searching || !q.trim()} className="h-12">
          <Search className="size-5" /> Search
        </Button>
      </form>

      {results !== null && results.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {searching ? "Searching…" : "No matching registrations in this event."}
        </p>
      )}

      <div className="space-y-2">
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
                    Checked in {formatBangkok(r.checkedInAt)}
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
                    <Undo2 className="size-4" /> Undo
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
                    onClick={() => manualCheckin(r)}
                  >
                    <UserCheck className="size-4" />
                    {busyId === r.registrationId ? "Checking in…" : "Check in"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Undo reason dialog — reason is mandatory (audit). */}
      <Dialog open={undoTarget !== null} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo check-in</DialogTitle>
            <DialogDescription>
              {undoTarget ? `Revert ${undoTarget.fullName} to registered.` : ""} A reason is
              required and will be recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="undo-reason">Reason</Label>
            <Textarea
              id="undo-reason"
              value={undoReason}
              onChange={(e) => setUndoReason(e.target.value)}
              placeholder="Why are you undoing this check-in?"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUndoTarget(null)} disabled={undoBusy}>
              Cancel
            </Button>
            <Button onClick={submitUndo} disabled={undoBusy || !undoReason.trim()}>
              {undoBusy ? "Undoing…" : "Undo check-in"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
