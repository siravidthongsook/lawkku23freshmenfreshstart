"use client";

// Admin > Users Export. Filter-rich page → downloads a CSV of users matching the chosen filters.
// Mirrors the users list filters (q/role/status/claimed) and adds export-only filters
// (group, created date range, never-active) plus a column picker.
// No separate temp-pw filter: pending temp-pw is a strict subset of claimed=no, so it's merged
// into the claimed filter (and kept only as an export COLUMN in the picker below).
// Backend GET /admin/users/export streams CSV (Content-Disposition + X-Row-Count); we trigger a blob download.
// Count preview reuses GET /admin/users?...&limit=1 (best-effort: list may not support every filter — we send the supported subset).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiGet, ApiError } from "@/lib/api";
import { downloadFile, toQuery } from "@/components/admin-tools/download";
import type { UserListResponse } from "@/components/admin-tools/wire";
import type { Role } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

// "all" is a UI-only sentinel; we omit the param from the query when selected. (Mirrors users/page.tsx.)
const ROLE_OPTIONS: { value: Role | "all"; label: string }[] = [
  { value: "all", label: "ทุกบทบาท" },
  { value: "student", label: "นักศึกษา" },
  { value: "checkin_staff", label: "เจ้าหน้าที่" },
  { value: "admin", label: "ผู้ดูแลระบบ" },
];
const STATUS_OPTIONS: { value: "all" | "active" | "disabled"; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "active", label: "บัญชีใช้ได้อยู่" },
  { value: "disabled", label: "ปิดใช้งาน" },
];
// No separate temp-pw filter: "รอใช้รหัสผ่านชั่วคราว" is merged into claimed=no (a strict subset).
const CLAIM_OPTIONS: { value: "all" | "yes" | "no"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "yes", label: "ยืนยันบัญชีแล้ว" },
  { value: "no", label: "ยังไม่ยืนยันบัญชี (ยังไม่เปลี่ยนรหัสชั่วคราวหรือยังไม่เคลมบัญชี)" },
];

// Column allow-list mirrors the backend; order here is the display order.
// `temp_password` is a plaintext secret → opt-in (default UNCHECKED); every other column defaults checked.
const COLUMNS: { key: string; label: string }[] = [
  { key: "student_id", label: "รหัสนักศึกษา" },
  { key: "full_name", label: "ชื่อ-สกุล" },
  { key: "email", label: "อีเมล" },
  { key: "username", label: "ชื่อผู้ใช้" },
  { key: "role", label: "บทบาท" },
  { key: "status", label: "สถานะ" },
  { key: "group_number", label: "กลุ่ม" },
  { key: "faculty", label: "คณะ" },
  { key: "department", label: "สาขา" },
  { key: "phone", label: "เบอร์โทร" },
  { key: "instagram", label: "instagram" },
  { key: "claimed", label: "ยืนยันบัญชีแล้ว" },
  { key: "pending_temp_pw", label: "รอใช้รหัสผ่านชั่วคราว" },
  { key: "temp_password", label: "รหัสผ่านชั่วคราว (ค่าจริง)" },
  { key: "created_at_bangkok", label: "สร้างเมื่อ" },
  { key: "last_active_at_bangkok", label: "ใช้งานล่าสุด" },
];

// Plaintext-secret columns default UNCHECKED (opt-in). Everything else is checked by default.
const SECRET_COLS = new Set<string>(["temp_password"]);
const DEFAULT_COLS = COLUMNS.map((c) => c.key).filter((k) => !SECRET_COLS.has(k));

export default function UsersExportPage() {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [claimed, setClaimed] = useState<"all" | "yes" | "no">("all");
  const [group, setGroup] = useState<string>("all"); // "all" or "1".."16"
  const [createdFrom, setCreatedFrom] = useState(""); // YYYY-MM-DD (Bangkok-local date)
  const [createdTo, setCreatedTo] = useState("");
  const [neverActive, setNeverActive] = useState(false);
  const [reason, setReason] = useState(""); // required ONLY when exporting the plaintext temp_password column

  // Column picker — all checked by default EXCEPT plaintext-secret columns (temp_password, opt-in).
  const [selectedCols, setSelectedCols] = useState<Set<string>>(() => new Set(DEFAULT_COLS));

  const [count, setCount] = useState<number | null>(null); // matching rows (best-effort preview); null = unknown/loading
  const [countLoading, setCountLoading] = useState(false);
  const [pending, setPending] = useState(false);

  // Filters the LIST endpoint is known to support → used for the count preview only.
  const supportedListQuery = useCallback(
    () =>
      toQuery({
        q: q.trim() || undefined,
        role: role !== "all" ? role : undefined,
        status: status !== "all" ? status : undefined,
        claimed: claimed !== "all" ? claimed : undefined,
        limit: "1",
      }),
    [q, role, status, claimed],
  );

  // Full filter set sent to the export endpoint. Omits empty/all via toQuery.
  const exportQuery = useCallback(
    () =>
      toQuery({
        q: q.trim() || undefined,
        role: role !== "all" ? role : undefined,
        status: status !== "all" ? status : undefined,
        claimed: claimed !== "all" ? claimed : undefined,
        group_number: group !== "all" ? group : undefined,
        created_from: createdFrom || undefined,
        created_to: createdTo || undefined,
        never_active: neverActive ? "true" : undefined,
        // Always send the explicit selection — NOT omitting, because the backend's no-columns default
        // includes temp_password (plaintext). Sending the picked set keeps temp_password opt-in.
        columns: COLUMNS.filter((c) => selectedCols.has(c.key)).map((c) => c.key).join(","),
        // Reason sent ONLY when the plaintext temp_password column is selected (backend requires it then).
        reason: selectedCols.has("temp_password") ? reason.trim() || undefined : undefined,
      }),
    [q, role, status, claimed, group, createdFrom, createdTo, neverActive, selectedCols, reason],
  );

  // Debounced count preview (300ms) on the supported subset of filters. Best-effort: failure hides the count.
  const initial = useRef(true);
  useEffect(() => {
    const first = initial.current;
    const t = setTimeout(
      () => {
        initial.current = false;
        setCountLoading(true);
        apiGet<UserListResponse>(`/admin/users${supportedListQuery()}`)
          .then((res) => setCount(res.total ?? null))
          .catch(() => setCount(null))
          .finally(() => setCountLoading(false));
      },
      first ? 0 : 300,
    );
    return () => clearTimeout(t);
  }, [supportedListQuery]);

  function toggleCol(key: string) {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runExport() {
    if (selectedCols.size === 0) {
      toast.error("เลือกอย่างน้อยหนึ่งคอลัมน์");
      return;
    }
    // Plaintext temp-pw export must carry a reason (mirrors the backend reason_required gate).
    if (selectedCols.has("temp_password") && !reason.trim()) {
      toast.error("ต้องระบุเหตุผลเมื่อส่งออกรหัสผ่านชั่วคราว");
      return;
    }
    setPending(true);
    try {
      const { rowCount } = await downloadFile(`/admin/users/export${exportQuery()}`, "users-export.csv");
      // Warn on an empty export — easy to mistake a 0-row CSV for success.
      if (rowCount === 0) {
        toast.warning("ส่งออกแล้ว แต่ไม่พบผู้ใช้ที่ตรงกับตัวกรอง (ไฟล์ว่าง)");
      } else if (rowCount != null) {
        toast.success(`ดาวน์โหลดรายชื่อผู้ใช้แล้ว (${rowCount} รายการ)`);
      } else {
        toast.success("ดาวน์โหลดรายชื่อผู้ใช้แล้ว");
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถส่งออกได้");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ส่งออกผู้ใช้</h1>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/users">กลับไปที่ผู้ใช้</Link>
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="q">ค้นหา</Label>
              <Input
                id="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="อีเมล รหัสนักศึกษา ชื่อผู้ใช้ หรือชื่อ"
              />
            </div>
            <div className="space-y-1.5">
              <Label>บทบาท</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role | "all")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>สถานะ</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "all" | "active" | "disabled")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>การยืนยันบัญชี</Label>
              <Select value={claimed} onValueChange={(v) => setClaimed(v as "all" | "yes" | "no")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLAIM_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* claimed=no covers temp-pw-waiting users too (pending temp pw ⊂ not-claimed); baked into the option label. */}
            </div>
            <div className="space-y-1.5">
              <Label>กลุ่ม</Label>
              <Select value={group} onValueChange={setGroup}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">ทุกกลุ่ม</SelectItem>
                  {Array.from({ length: 16 }, (_, i) => String(i + 1)).map((n) => (
                    <SelectItem key={n} value={n}>
                      กลุ่ม {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="created-from">สร้างตั้งแต่</Label>
              <Input
                id="created-from"
                type="date"
                value={createdFrom}
                onChange={(e) => setCreatedFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="created-to">สร้างถึง</Label>
              <Input
                id="created-to"
                type="date"
                value={createdTo}
                onChange={(e) => setCreatedTo(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input accent-primary"
              checked={neverActive}
              onChange={(e) => setNeverActive(e.target.checked)}
            />
            ยังไม่เคยเข้าใช้งาน
          </label>

          {/* Count preview is best-effort: it ignores the export-only filters the list endpoint can't honor. */}
          <p className="text-xs text-muted-foreground">
            {countLoading ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3.5 animate-spin" /> กำลังตรวจสอบจำนวน…
              </span>
            ) : count != null ? (
              `พบ ${count} รายการ (โดยประมาณ — ตัวกรองบางรายการนับเฉพาะตอนส่งออก)`
            ) : (
              "ไม่สามารถแสดงจำนวนได้"
            )}
          </p>
        </CardContent>
      </Card>

      {/* Column picker */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">คอลัมน์ที่ส่งออก</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMNS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-primary"
                  checked={selectedCols.has(c.key)}
                  onChange={() => toggleCol(c.key)}
                />
                {c.label}
              </label>
            ))}
          </div>
          {/* Warning + required reason shown only while the plaintext temp-password column is opted in. */}
          {selectedCols.has("temp_password") ? (
            <div className="mt-3 space-y-2">
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                ⚠️ มีรหัสผ่านจริง โปรดเก็บไฟล์อย่างปลอดภัย ส่งให้เฉพาะผู้ที่เกี่ยวข้อง และลบเมื่อเสร็จสิ้น
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="reason">เหตุผลในการส่งออกรหัสผ่าน</Label>
                <Input
                  id="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="ระบุเหตุผล..."
                />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={runExport} disabled={pending}>
          {pending
            ? "กำลังเตรียม…"
            : count != null
              ? `ดาวน์โหลด CSV (${count} รายการ)`
              : "ดาวน์โหลด CSV"}
        </Button>
      </div>
    </div>
  );
}
