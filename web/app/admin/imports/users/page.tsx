"use client";

// Admin > Import Users. Validate-first flow: upload CSV → preview (per-row statuses) → confirm.
// Scope: user_pool_only OR user_pool_and_register_to_event (needs targetEventId). When the preview
// flags will_register_over_capacity rows under the register scope, the admin must acknowledge +
// give a reason before confirming (backend auto-audits the over-capacity override).
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiPostForm, apiPost, ApiError } from "@/lib/api";
import { confirmImportSchema } from "@/lib/schemas";
import { downloadFile } from "@/components/admin-tools/download";
import { RowStatusBadge } from "@/components/admin-tools/row-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ImportConfirmResponse,
  ImportPreviewResponse,
} from "@/components/admin-tools/wire";

type Scope = "user_pool_only" | "user_pool_and_register_to_event";

export default function ImportUsersPage() {
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState<Scope>("user_pool_only");
  const [targetEventId, setTargetEventId] = useState("");

  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ImportConfirmResponse | null>(null);

  // Over-capacity acknowledgement when registering to an event.
  const [overCapAck, setOverCapAck] = useState(false);
  const [reason, setReason] = useState("");

  const registerToEvent = scope === "user_pool_and_register_to_event";

  // Count of rows flagged over-capacity in the current preview.
  const overCapCount = useMemo(
    () =>
      preview?.rows.filter((r) => r.status === "will_register_over_capacity").length ?? 0,
    [preview],
  );

  async function runPreview() {
    if (!file) {
      toast.error("Choose a CSV file first");
      return;
    }
    if (registerToEvent && !targetEventId.trim()) {
      toast.error("Target event ID is required for register-to-event imports");
      return;
    }
    setPreviewing(true);
    setResult(null);
    setOverCapAck(false);
    setReason("");
    const form = new FormData();
    form.set("file", file);
    form.set("scope", scope);
    if (registerToEvent) form.set("targetEventId", targetEventId.trim());
    try {
      const res = await apiPostForm<ImportPreviewResponse>(
        "/admin/imports/users/preview",
        form,
      );
      setPreview(res);
      toast.success("Preview ready");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not preview import");
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function runConfirm() {
    if (!preview) return;
    // Over-capacity register requires acknowledgement + reason (UI gate; backend auto-audits).
    if (registerToEvent && overCapCount > 0) {
      if (!overCapAck) {
        toast.error("Acknowledge the over-capacity registrations to continue");
        return;
      }
      if (reason.trim().length === 0) {
        toast.error("A reason is required to register over capacity");
        return;
      }
    }

    const payload = {
      importId: preview.importId,
      scope,
      ...(registerToEvent ? { targetEventId: targetEventId.trim() } : {}),
    };
    const parsed = confirmImportSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid import options");
      return;
    }

    setConfirming(true);
    try {
      // confirmImportSchema does not carry reason/override; backend audits over-capacity itself.
      const res = await apiPost<ImportConfirmResponse>(
        "/admin/imports/users/confirm",
        parsed.data,
      );
      setResult(res);
      toast.success("Import confirmed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not confirm import");
    } finally {
      setConfirming(false);
    }
  }

  async function downloadResult() {
    const importId = result?.importId ?? preview?.importId;
    if (!importId) return;
    try {
      await downloadFile(
        `/admin/imports/${importId}/result`,
        `import-${importId}-result.csv`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not download result");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Import Users</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/users">Back to users</Link>
        </Button>
      </div>

      {/* Step 1 — upload + options */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Upload &amp; options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="file">CSV file</Label>
              <Input
                id="file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user_pool_only">User pool only</SelectItem>
                  <SelectItem value="user_pool_and_register_to_event">
                    User pool + register to event
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {registerToEvent ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="eventId">Target event ID</Label>
                <Input
                  id="eventId"
                  value={targetEventId}
                  onChange={(e) => setTargetEventId(e.target.value)}
                  placeholder="Event UUID"
                />
              </div>
            ) : null}
          </div>
          <Button onClick={runPreview} disabled={previewing}>
            {previewing ? "Previewing…" : "Preview"}
          </Button>
        </CardContent>
      </Card>

      {/* Step 2 — preview */}
      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Summary counts */}
            <div className="flex flex-wrap gap-2">
              {Object.entries(preview.counts).map(([k, v]) => (
                <span
                  key={k}
                  className="rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground"
                >
                  {k}: <strong className="text-foreground">{v}</strong>
                </span>
              ))}
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Student ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.rowNumber}>
                      <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                      <TableCell>{r.email}</TableCell>
                      <TableCell className="font-mono">{r.studentId ?? "—"}</TableCell>
                      <TableCell>{r.fullName}</TableCell>
                      <TableCell>
                        <RowStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.note ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Over-capacity gate (register scope only) */}
            {registerToEvent && overCapCount > 0 ? (
              <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm text-amber-900">
                  {overCapCount} row(s) will register the user over the event capacity. This is an
                  override and will be recorded in the audit log.
                </p>
                <label className="flex items-center gap-2 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    checked={overCapAck}
                    onChange={(e) => setOverCapAck(e.target.checked)}
                  />
                  I understand and want to register these users over capacity.
                </label>
                <div className="space-y-1.5">
                  <Label htmlFor="oc-reason">Reason (required)</Label>
                  <Textarea
                    id="oc-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why register over capacity?"
                  />
                </div>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button onClick={runConfirm} disabled={confirming}>
                {confirming ? "Confirming…" : "Confirm import"}
              </Button>
              <Button variant="outline" onClick={downloadResult}>
                Download preview result
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Step 3 — result */}
      {result ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md border bg-muted px-2 py-1">
                Created: <strong>{result.created}</strong>
              </span>
              <span className="rounded-md border bg-muted px-2 py-1">
                Updated: <strong>{result.updated}</strong>
              </span>
              <span className="rounded-md border bg-muted px-2 py-1">
                Registered: <strong>{result.registered}</strong>
              </span>
              <span className="rounded-md border bg-muted px-2 py-1">
                Over capacity: <strong>{result.over_capacity}</strong>
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              The result file includes generated temporary passwords for created users. Treat it as
              sensitive.
            </p>
            <Button variant="outline" onClick={downloadResult}>
              Download result CSV
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
