"use client";

// Registration List (dashboard L2). GET /admin/events/:id/registrations.
// NOTE: backend serializeRegistration currently returns reg-level fields only (no user profile / checked_in_by
// label / form_version label). We render those columns from the row when present and fall back to "—".
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { RegistrationListItem } from "@/lib/types";
import { formatBangkok } from "@/lib/time";
import { RegistrationStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function EventRegistrationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<RegistrationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ registrations: RegistrationListItem[] }>(
        `/admin/events/${id}/registrations`,
      );
      setRows(res.registrations ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load registrations.");
      setRows([]);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/events/${id}`}>
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Registrations</h1>
        </div>
        <Button onClick={() => setManualOpen(true)}>
          <UserPlus className="size-4" />
          Manual register
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          No registrations yet.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Faculty</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Registered</TableHead>
                <TableHead>Checked in</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Form ver.</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.studentId ?? "—"}</TableCell>
                  <TableCell className="font-medium">{r.fullName ?? "—"}</TableCell>
                  <TableCell>{r.faculty ?? "—"}</TableCell>
                  <TableCell>{r.department ?? "—"}</TableCell>
                  <TableCell>
                    <RegistrationStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatBangkok(r.registeredAt) || "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatBangkok(r.checkedInAt) || "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.checkedInBy ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.formVersion ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/admin/registrations/${r.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ManualRegisterDialog
        eventId={id}
        open={manualOpen}
        onOpenChange={setManualOpen}
        onDone={load}
      />
    </div>
  );
}

// Manual register (override window/capacity). userId + reason REQUIRED. POST /admin/events/:id/registrations.
function ManualRegisterDialog({
  eventId,
  open,
  onOpenChange,
  onDone,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Both fields required — reason is mandatory (audited override).
  const valid = userId.trim() !== "" && reason.trim() !== "";

  function reset() {
    setUserId("");
    setReason("");
  }

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await apiPost(`/admin/events/${eventId}/registrations`, {
        userId: userId.trim(),
        reason: reason.trim(),
        answers: {}, // admins may leave answers empty; backend validates against active form
      });
      toast.success("User registered.");
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to register user.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manual register</DialogTitle>
          <DialogDescription>
            Overrides the registration window and capacity. Recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="userId">User ID (UUID)</Label>
            <Input
              id="userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="manual-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? "Working…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
