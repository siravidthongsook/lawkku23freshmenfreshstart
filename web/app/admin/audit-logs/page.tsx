"use client";

// Admin > Audit Log Viewer. Global, filterable, read-only. Secrets are already redacted by the
// backend at write-time — render as-is. Times shown in Asia/Bangkok. Paginated via limit/offset.
import { useCallback, useEffect, useState } from "react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditLogListResponse, AuditLogWire } from "@/components/admin-tools/wire";

const PAGE_SIZE = 50;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดบันทึกการตรวจสอบได้");
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [action, entityType, targetUserId, from, to, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Apply filters → reset to first page (load runs via the offset effect dep).
  function applyFilters() {
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
              <Label htmlFor="action">การกระทำ</Label>
              <Input
                id="action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="เช่น user_role_changed"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entity">ประเภทเอนทิตี</Label>
              <Input
                id="entity"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                placeholder="เช่น user, event"
              />
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
              <Label htmlFor="afrom">ตั้งแต่</Label>
              <Input
                id="afrom"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ato">ถึง</Label>
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
                    {logs.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatBangkok(l.created_at)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{l.action}</TableCell>
                        <TableCell className="text-xs">
                          {l.actor_role ? <Badge variant="secondary">{l.actor_role}</Badge> : null}
                          <span className="ml-1 break-all text-muted-foreground">
                            {l.actor_user_id ?? "system"}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {l.entity_type ?? "—"}
                          {l.entity_id ? `:${l.entity_id.slice(0, 8)}` : ""}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs" title={l.reason ?? ""}>
                          {l.reason ?? ""}
                        </TableCell>
                        <TableCell
                          className="max-w-[20rem] truncate text-xs text-muted-foreground"
                          title={preview(l.metadata)}
                        >
                          {preview(l.metadata)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination — offset based; backend has no total, so Next disables on short pages. */}
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  กำลังแสดง {offset + 1}–{offset + logs.length}
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
                    disabled={logs.length < PAGE_SIZE}
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
