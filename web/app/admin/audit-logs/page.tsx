"use client";

// Admin > Audit Log Viewer. Global, filterable, read-only. Secrets are already redacted by the
// backend at write-time — render as-is. Times shown in Asia/Bangkok. Paginated via limit/offset.
import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiGet, ApiError } from "@/lib/api";
import { formatBangkok } from "@/lib/time";
import { bangkokInputToIso } from "@/components/admin-events/datetime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { auditActionLabel, auditEntityLabel } from "@/lib/labels";
import type { AuditLogListResponse, AuditLogWire } from "@/components/admin-tools/wire";

const PAGE_SIZE = 50;

// Known action/entity values (mirrors labels.ts maps) → dropdowns instead of typo-prone free text.
// "all" is a UI-only sentinel; we omit the param when selected.
const ACTION_OPTIONS = [
  "account_temporarily_locked", "admin_unlocked_account", "admin_password_reset",
  "password_changed", "temp_password_revealed", "temp_password_exported",
  "user_created", "user_disabled", "user_enabled", "user_role_changed",
  "user_profile_updated", "user_self_profile_updated", "users_imported",
  "event_status_changed", "event_visibility_changed", "event_slug_changed",
  "event_poster_uploaded", "form_version_created",
  "registration_created", "registration_cancelled", "registration_promoted",
  "registration_demoted", "registration_answers_edited", "admin_edit_registration_answer",
  "admin_register_over_capacity", "registration_exported",
  "qr_scan_checkin", "manual_checkin", "manual_checkin_undo", "qr_regenerated", "qr_revoked",
  "uploaded_file_added", "uploaded_file_downloaded",
];
const ENTITY_OPTIONS = [
  "auth", "user", "user_import", "event", "event_form_version", "registration", "uploaded_file",
];

// Compact one-line preview of a jsonb value for the table cell.
function preview(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function AuditLogsPage() {
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const [logs, setLogs] = useState<AuditLogWire[]>([]);
  const [total, setTotal] = useState<number | null>(null); // null when backend omits it (fallback to short-page heuristic)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // id of the row whose details are open

  // datetime-local → ISO UTC. Input is Bangkok wall-clock (spec), not browser-local.
  function localToIso(local: string): string | undefined {
    return bangkokInputToIso(local) ?? undefined;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams();
    if (action.trim()) sp.set("action", action.trim());
    if (entityType.trim()) sp.set("entity_type", entityType.trim());
    if (targetUserId.trim()) sp.set("target_user_id", targetUserId.trim());
    const fromIso = localToIso(from);
    const toIso = localToIso(to);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    sp.set("limit", String(PAGE_SIZE));
    sp.set("offset", String(offset));
    try {
      const res = await apiGet<AuditLogListResponse>(`/admin/audit-logs?${sp.toString()}`);
      setLogs(res.logs ?? []);
      setTotal(typeof res.total === "number" ? res.total : null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดบันทึกการตรวจสอบได้");
      setLogs([]);
      setTotal(null);
    } finally {
      setLoading(false);
    }
  }, [action, entityType, targetUserId, from, to, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Apply filters → reset to first page (load runs via the offset effect dep). Toast so it's clear it ran.
  function applyFilters() {
    toast.success("ใช้ตัวกรองแล้ว");
    if (offset === 0) load();
    else setOffset(0);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">บันทึกการตรวจสอบ</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label>การกระทำ</Label>
              <Select
                value={action || "all"}
                onValueChange={(v) => setAction(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ทุกการกระทำ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">ทุกการกระทำ</SelectItem>
                  {ACTION_OPTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {auditActionLabel(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>ประเภทเอนทิตี</Label>
              <Select
                value={entityType || "all"}
                onValueChange={(v) => setEntityType(v === "all" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ทุกประเภท" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">ทุกประเภท</SelectItem>
                  {ENTITY_OPTIONS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {auditEntityLabel(e)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actor">รหัสผู้ใช้เป้าหมาย</Label>
              <Input
                id="actor"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                placeholder="UUID"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="afrom">ตั้งแต่ (เวลาไทย)</Label>
              <Input
                id="afrom"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ato">ถึง (เวลาไทย)</Label>
              <Input
                id="ato"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={applyFilters}>ใช้ตัวกรอง</Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>
                ลองใหม่
              </Button>
            </div>
          ) : logs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">ไม่พบบันทึกการตรวจสอบ</p>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>เวลา</TableHead>
                      <TableHead>การกระทำ</TableHead>
                      <TableHead>ผู้กระทำ</TableHead>
                      <TableHead>เอนทิตี</TableHead>
                      <TableHead>เหตุผล</TableHead>
                      <TableHead>รายละเอียด</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((l) => {
                      const isOpen = expanded === l.id;
                      // Row carries readable details when there's reason or metadata to show.
                      const hasDetails = !!l.reason || l.metadata != null;
                      return (
                        <Fragment key={l.id}>
                          <TableRow
                            className={hasDetails ? "cursor-pointer" : undefined}
                            onClick={() => hasDetails && setExpanded(isOpen ? null : l.id)}
                          >
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatBangkok(l.created_at)}
                            </TableCell>
                            <TableCell className="text-xs">{auditActionLabel(l.action)}</TableCell>
                            <TableCell className="text-xs">
                              {l.actor_role ? <Badge variant="secondary">{l.actor_role}</Badge> : null}
                              <span className="ml-1 break-all text-muted-foreground">
                                {l.actor_user_id ?? "system"}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {auditEntityLabel(l.entity_type)}
                              {l.entity_id ? `:${l.entity_id.slice(0, 8)}` : ""}
                            </TableCell>
                            <TableCell className="max-w-[16rem] truncate text-xs">
                              {l.reason ?? ""}
                            </TableCell>
                            <TableCell className="max-w-[20rem] truncate text-xs text-muted-foreground">
                              {hasDetails ? (isOpen ? "ซ่อนรายละเอียด" : preview(l.metadata) || "ดูรายละเอียด") : ""}
                            </TableCell>
                          </TableRow>
                          {/* Expandable details row — full reason + metadata, readable on mobile. */}
                          {isOpen ? (
                            <TableRow>
                              <TableCell colSpan={6} className="bg-muted/40">
                                <div className="space-y-2 py-1 text-xs">
                                  {l.reason ? (
                                    <div>
                                      <span className="font-medium">เหตุผล: </span>
                                      {l.reason}
                                    </div>
                                  ) : null}
                                  {l.metadata != null ? (
                                    <pre className="overflow-x-auto rounded-md bg-background p-2">
                                      {preview(l.metadata)}
                                    </pre>
                                  ) : null}
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination — prefer the backend total (fixes the exact-page-size empty-Next bug);
                  fall back to the short-page heuristic only when total is absent. */}
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  กำลังแสดง {offset + 1}–{offset + logs.length}
                  {total != null ? ` จาก ${total}` : ""}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  >
                    ก่อนหน้า
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      total != null ? offset + logs.length >= total : logs.length < PAGE_SIZE
                    }
                    onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  >
                    ถัดไป
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
