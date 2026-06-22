"use client";

// Registration Detail (L3). GET /admin/registrations/:id → { registration, answers, fileIds, auditHistory }.
// ALL mutating actions require a reason and emit an audit log; we gate each behind the ReasonDialog.
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import type { RegistrationStatus } from "@/lib/types";
import { checkinMethodLabel, qrStatusLabel } from "@/lib/labels";
import { formatBangkok } from "@/lib/time";
import { RegistrationStatusBadge } from "@/components/badges";
import { ReasonDialog } from "@/components/admin-events/reason-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Reg row as serialized by the backend (registrations service.serializeRegistration).
type RegistrationDetail = {
  id: string;
  eventId: string;
  userId: string;
  status: RegistrationStatus;
  formVersionId: string | null;
  registeredAt: string | null;
  waitlistedAt: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null; // scan-out stamp (admin state-override panel)
  cancelledAt: string | null;
  checkinMethod: string | null;
  checkedInBy: string | null; // display name of the staff/admin who checked in
  checkedOutBy: string | null; // display name of the staff/admin who checked out
  createdAt: string;
  updatedAt: string;
};

// Audit row (append-only). Shape inferred from audit table — render the common columns defensively.
type AuditRow = {
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
  actorUserId?: string | null;
};

// User identity joined onto the registration (so admins see WHO it is, not a raw UUID).
type RegUser = {
  userId: string;
  studentId: string | null;
  fullName: string | null;
  email: string | null;
  faculty: string | null;
  department: string | null;
};

type RegFile = { id: string; filename: string; mimeType: string };

type DetailResponse = {
  registration: RegistrationDetail;
  user?: RegUser;
  answers: Record<string, unknown>;
  files?: RegFile[];
  fileIds: string[]; // legacy fallback when `files` absent
  qr?: { eligible: boolean; active: boolean };
  auditHistory: AuditRow[];
};

// Thai labels for each registration status (used by the unified status dropdown + dialog copy).
const STATUS_LABEL: Record<RegistrationStatus, string> = {
  registered: "ลงทะเบียนแล้ว",
  waitlisted: "รายชื่อสำรอง",
  checked_in: "เช็คอินแล้ว",
  cancelled: "ยกเลิก",
};
const STATUS_ORDER: RegistrationStatus[] = ["registered", "waitlisted", "checked_in", "cancelled"];

// One axis (check-in or check-out) of the state-override panel. "unchanged" = leave as-is.
type AxisAction = "unchanged" | "set" | "clear";
// Axis payload sent to the backend; `at` is ISO-UTC (converted from the naive Bangkok picker).
type AxisPayload =
  | { action: "set"; at?: string; awardPoints: boolean }
  | { action: "clear" }
  | { action: "unchanged" };

// Which reason-gated action the dialog is currently driving.
type Action =
  | { kind: "set_status"; status: RegistrationStatus }
  | { kind: "qr_regenerate" }
  | { kind: "qr_revoke" }
  | { kind: "edit_answers" }
  | { kind: "checkin_state"; checkin: AxisPayload; checkout: AxisPayload }; // admin stamp override

type ActionMeta = { title: string; description: string; confirm: string; destructive?: boolean };

const STATIC_ACTION_META: Record<
  Exclude<Action["kind"], "set_status">,
  ActionMeta
> = {
  qr_regenerate: {
    title: "สร้าง QR ใหม่",
    description: "เพิกถอน QR ปัจจุบันและออก QR ใหม่",
    confirm: "สร้างใหม่",
  },
  qr_revoke: {
    title: "เพิกถอน QR",
    description: "เพิกถอนโทเค็น QR ที่ใช้งานอยู่ นักศึกษาจะไม่สามารถเช็คอินได้จนกว่าจะออกใหม่",
    confirm: "เพิกถอน",
    destructive: true,
  },
  edit_answers: {
    title: "แก้ไขคำตอบ",
    description: "บันทึกคำตอบที่แก้ไขกับเวอร์ชันฟอร์มของการลงทะเบียนนั้นเอง",
    confirm: "บันทึกคำตอบ",
  },
  checkin_state: {
    title: "ปรับสถานะเช็คอิน/เช็คเอาท์",
    description: "ตั้ง/ล้าง/ย้อนเวลาเช็คอินและเช็คเอาท์โดยตรง (ข้ามกรอบเวลาและการตั้งค่า) — บันทึกการตรวจสอบเสมอ",
    confirm: "บันทึก",
  },
};

// Convert a naive datetime-local value ("2026-06-20T14:30") — read as Asia/Bangkok wall time —
// into a UTC ISO string for the wire. Empty → undefined (backend defaults to now()).
function bangkokLocalToUtcIso(local: string): string | undefined {
  if (!local) return undefined;
  // datetime-local omits seconds/offset; pin it to +07:00 then normalize to UTC.
  const d = new Date(`${local}:00+07:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// Dialog copy for the current action — status change is dynamic (depends on the chosen target).
function metaFor(action: Action): ActionMeta {
  if (action.kind === "set_status") {
    return {
      title: `เปลี่ยนสถานะเป็น “${STATUS_LABEL[action.status]}”`,
      description:
        "เปลี่ยนสถานะการลงทะเบียนโดยตรง — ระบบจะออก/เพิกถอน QR และปรับเวลาให้ตามสถานะ" +
        (action.status === "cancelled" ? " และยกเลิกแต้มเช็คอินที่เคยได้ (ถ้ามี)" : ""),
      confirm: "เปลี่ยนสถานะ",
      destructive: action.status === "cancelled",
    };
  }
  return STATIC_ACTION_META[action.kind];
}

export default function RegistrationDetailPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
}) {
  const { registrationId } = use(params);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  // Editable answers buffer (only sent on the "edit_answers" action).
  const [draftAnswers, setDraftAnswers] = useState<Record<string, unknown>>({});
  // Per-field client errors (e.g. invalid number) — block save when present.
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});

  // ---- Check-in/out state-override panel (admin stamp control) ----
  const [inAction, setInAction] = useState<AxisAction>("unchanged");
  const [outAction, setOutAction] = useState<AxisAction>("unchanged");
  const [inAt, setInAt] = useState(""); // naive datetime-local (Bangkok wall time); empty = now()
  const [outAt, setOutAt] = useState("");
  const [inAward, setInAward] = useState(true);
  const [outAward, setOutAward] = useState(true);

  // Answers are dirty when the draft differs from what's stored — gates the save button + audit noise.
  const answersDirty = data
    ? JSON.stringify(draftAnswers) !== JSON.stringify(data.answers ?? {})
    : false;
  const hasAnswerError = Object.keys(answerErrors).length > 0;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiGet<DetailResponse>(`/admin/registrations/${registrationId}`);
      setData(res);
      setDraftAnswers(res.answers ?? {});
      setAnswerErrors({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดการลงทะเบียนได้");
    }
  }, [registrationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Single reason-gated mutation dispatcher. Throws on failure to keep the dialog open.
  async function runAction(reason: string) {
    const base = `/admin/registrations/${registrationId}`;
    if (!action) return;
    switch (action.kind) {
      case "set_status":
        await apiPost(`${base}/status`, { status: action.status, reason });
        break;
      case "qr_regenerate":
        await apiPost(`${base}/qr/regenerate`, { reason });
        break;
      case "qr_revoke":
        await apiPost(`${base}/qr/revoke`, { reason });
        break;
      case "edit_answers":
        // Guard: never PATCH invalid numbers (would have saved NaN before).
        if (hasAnswerError) throw new ApiError("invalid_answers", "มีคำตอบที่ไม่ถูกต้อง", 400);
        await apiPatch(`${base}/answers`, { answers: draftAnswers, reason });
        break;
      case "checkin_state": {
        const res = await apiPost<{ points_skipped?: string[] }>(`${base}/checkin-state`, {
          checkin: action.checkin,
          checkout: action.checkout,
          reason,
        });
        // Stamp committed but points withheld (cutoff/toggle/role) → warn the admin explicitly. [E1/E2]
        if (res.points_skipped && res.points_skipped.length > 0) {
          toast.warning(`บันทึกเวลาแล้ว แต่ไม่ได้ให้แต้ม: ${res.points_skipped.join(", ")}`);
        } else {
          toast.success("เสร็จสิ้น มีการบันทึกไว้ในบันทึกการตรวจสอบ");
        }
        await load();
        return; // own toast above; skip the generic success
      }
    }
    toast.success("เสร็จสิ้น มีการบันทึกไว้ในบันทึกการตรวจสอบ");
    await load();
  }

  // Build one axis payload from the panel controls (set carries at/awardPoints; clear/unchanged are bare).
  function buildAxis(act: AxisAction, atLocal: string, award: boolean): AxisPayload {
    if (act === "set") return { action: "set", at: bangkokLocalToUtcIso(atLocal), awardPoints: award };
    if (act === "clear") return { action: "clear" };
    return { action: "unchanged" };
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const reg = data.registration;
  const status = reg.status;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/events/${reg.eventId}/registrations`}>
              <ArrowLeft className="size-4" />
              ย้อนกลับ
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">การลงทะเบียน</h1>
          <RegistrationStatusBadge status={status} />
        </div>
        {/* Status-aware action buttons. Each opens the reason dialog. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Unified status override — pick any other status; opens the reason dialog to confirm. */}
          <Select
            value={status}
            onValueChange={(v) => setAction({ kind: "set_status", status: v as RegistrationStatus })}
          >
            <SelectTrigger className="h-9 w-44" aria-label="เปลี่ยนสถานะ">
              <SelectValue placeholder="เปลี่ยนสถานะ" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s} disabled={s === status}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {status !== "cancelled" && status !== "waitlisted" ? (
            <>
              {/* Show current QR state so the admin knows what regenerate/revoke will do. */}
              {data.qr ? (
                <Badge
                  className={
                    data.qr.active
                      ? "border-transparent bg-green-100 text-green-800"
                      : "border-transparent bg-zinc-200 text-zinc-700"
                  }
                >
                  QR: {data.qr.active ? qrStatusLabel("active") : "ไม่มี QR ที่ใช้งานอยู่"}
                </Badge>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAction({ kind: "qr_regenerate" })}
              >
                {data.qr?.active ? "สร้าง QR ใหม่" : "ออก QR"}
              </Button>
              {/* Revoke only makes sense when there IS an active token. */}
              <Button
                variant="outline"
                size="sm"
                disabled={data.qr ? !data.qr.active : false}
                onClick={() => setAction({ kind: "qr_revoke" })}
              >
                เพิกถอน QR
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Who is this? Identity from the joined user, so admins act on the right person (not a UUID). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">ผู้ลงทะเบียน</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="ชื่อ-นามสกุล" value={data.user?.fullName ?? "—"} />
          <Detail label="รหัสนักศึกษา" value={data.user?.studentId ?? "—"} mono />
          <Detail label="อีเมล" value={data.user?.email ?? "—"} />
          <Detail label="คณะ" value={data.user?.faculty ?? "—"} />
          <Detail label="สาขา" value={data.user?.department ?? "—"} />
          <Detail label="รหัสผู้ใช้" value={reg.userId} mono />
        </CardContent>
      </Card>

      {/* Registration status / timestamps. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">รายละเอียด</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="รหัสเวอร์ชันฟอร์ม" value={reg.formVersionId ?? "—"} mono />
          <Detail label="ลงทะเบียน" value={formatBangkok(reg.registeredAt) || "—"} />
          <Detail label="อยู่ในรายชื่อสำรอง" value={formatBangkok(reg.waitlistedAt) || "—"} />
          <Detail label="เช็คอินแล้ว" value={formatBangkok(reg.checkedInAt) || "—"} />
          <Detail label="วิธีการเช็คอิน" value={reg.checkinMethod ? checkinMethodLabel(reg.checkinMethod) : "—"} />
          <Detail label="เช็คเอาท์แล้ว" value={formatBangkok(reg.checkedOutAt) || "—"} />
          <Detail label="เช็คอินโดย" value={reg.checkedInBy ?? "—"} />
          <Detail label="เช็คเอาท์โดย" value={reg.checkedOutBy ?? "—"} />
          <Detail label="ยกเลิกแล้ว" value={formatBangkok(reg.cancelledAt) || "—"} />
        </CardContent>
      </Card>

      {/* Admin check-in/out state override: set/clear/backdate stamps directly (bypasses window/toggle/
          cutoff for the stamp; points still self-guard). All changes are reason-gated + audited. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">จัดการเช็คอิน/เช็คเอาท์</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {/* Resurrecting a cancelled/waitlisted reg via set-checkin is blocked server-side; mirror it here. */}
          {(status === "cancelled" || status === "waitlisted") ? (
            <p className="text-xs text-amber-600">
              ไม่สามารถตั้งเวลาเช็คอินได้ขณะสถานะเป็น “{STATUS_LABEL[status]}” — เปลี่ยนสถานะก่อน
            </p>
          ) : null}

          {/* CHECK-IN axis */}
          <AxisControl
            label="เช็คอิน"
            action={inAction}
            onAction={setInAction}
            at={inAt}
            onAt={setInAt}
            award={inAward}
            onAward={setInAward}
            disableSet={status === "cancelled" || status === "waitlisted"}
          />
          {/* CHECK-OUT axis */}
          <AxisControl
            label="เช็คเอาท์"
            action={outAction}
            onAction={setOutAction}
            at={outAt}
            onAt={setOutAt}
            award={outAward}
            onAward={setOutAward}
            disableSet={false}
          />

          <Button
            size="sm"
            disabled={inAction === "unchanged" && outAction === "unchanged"}
            onClick={() =>
              setAction({
                kind: "checkin_state",
                checkin: buildAxis(inAction, inAt, inAward),
                checkout: buildAxis(outAction, outAt, outAward),
              })
            }
          >
            บันทึกการเปลี่ยนแปลง
          </Button>
        </CardContent>
      </Card>

      {/* Files (download via authorized backend endpoint; opens stream). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">ไฟล์</CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            // Prefer the enriched `files` (filename + type); fall back to bare ids for older payloads.
            const files = data.files ?? data.fileIds.map((id) => ({ id, filename: id, mimeType: "" }));
            if (files.length === 0)
              return <p className="text-sm text-muted-foreground">ไม่มีไฟล์</p>;
            return (
              <ul className="space-y-2">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{f.filename}</p>
                      {f.mimeType ? (
                        <p className="text-xs text-muted-foreground">{f.mimeType}</p>
                      ) : null}
                    </div>
                    <Button asChild variant="outline" size="sm">
                      {/* Authorized download endpoint streams the file; admin download is audited server-side. */}
                      <a href={`/api/files/${f.id}/download`} target="_blank" rel="noreferrer">
                        <Download className="size-4" />
                        ดาวน์โหลด
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            );
          })()}
        </CardContent>
      </Card>

      {/* Form answers — editable. "Save answers" requires a reason + audits. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm">คำตอบ</CardTitle>
          {/* Disabled until something actually changed (no empty audit) and all answers are valid. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={!answersDirty || hasAnswerError}
            onClick={() => setAction({ kind: "edit_answers" })}
          >
            บันทึกคำตอบ
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(draftAnswers).length === 0 ? (
            <p className="text-sm text-muted-foreground">ไม่มีคำตอบที่บันทึกไว้</p>
          ) : (
            Object.entries(draftAnswers).map(([key, value]) => (
              <AnswerField
                key={key}
                fieldKey={key}
                value={value}
                // Original (saved) type decides coercion — survives mid-edit string drafts.
                wasNumber={typeof data.answers?.[key] === "number"}
                error={answerErrors[key]}
                onChange={(v) => setDraftAnswers((prev) => ({ ...prev, [key]: v }))}
                onError={(msg) =>
                  setAnswerErrors((prev) => {
                    const next = { ...prev };
                    if (msg) next[key] = msg;
                    else delete next[key];
                    return next;
                  })
                }
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Audit history for this registration (append-only). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">ประวัติการตรวจสอบ</CardTitle>
        </CardHeader>
        <CardContent>
          {data.auditHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">ไม่มีประวัติ</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>เมื่อ</TableHead>
                  <TableHead>การกระทำ</TableHead>
                  <TableHead>เหตุผล</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.auditHistory.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBangkok(a.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">{a.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.reason ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={action !== null}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
        title={action ? metaFor(action).title : ""}
        description={action ? metaFor(action).description : undefined}
        confirmLabel={action ? metaFor(action).confirm : "ยืนยัน"}
        destructive={action ? metaFor(action).destructive : false}
        onConfirm={runAction}
      />
    </div>
  );
}

// One axis (เช็คอิน / เช็คเอาท์) of the state-override panel: action select + optional datetime + award toggle.
function AxisControl({
  label,
  action,
  onAction,
  at,
  onAt,
  award,
  onAward,
  disableSet,
}: {
  label: string;
  action: AxisAction;
  onAction: (a: AxisAction) => void;
  at: string;
  onAt: (v: string) => void;
  award: boolean;
  onAward: (v: boolean) => void;
  disableSet: boolean; // block "set" (e.g. cancelled/waitlisted reg) — mirrors server reject [E5]
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs font-medium text-muted-foreground">{label}</span>
        <Select value={action} onValueChange={(v) => onAction(v as AxisAction)}>
          <SelectTrigger className="h-8 w-36" aria-label={`${label} action`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unchanged">ไม่เปลี่ยน</SelectItem>
            <SelectItem value="set" disabled={disableSet}>ตั้งเวลา</SelectItem>
            <SelectItem value="clear">ล้าง</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {action === "set" ? (
        <div className="flex flex-wrap items-center gap-3 pl-22">
          {/* Naive Bangkok wall time; empty = ตอนนี้ (server now()). Converted to UTC before POST. */}
          <input
            type="datetime-local"
            className="rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={at}
            onChange={(e) => onAt(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">เว้นว่าง = ตอนนี้</span>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={award} onChange={(e) => onAward(e.target.checked)} />
            ให้แต้ม
          </label>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-xs" : ""}>{value}</p>
    </div>
  );
}

// Render a single answer as an editable input. Strings/numbers inline; arrays/objects read-only JSON.
// Number fields guard against NaN: empty/non-numeric input reports an error instead of saving NaN.
function AnswerField({
  fieldKey,
  value,
  wasNumber,
  error,
  onChange,
  onError,
}: {
  fieldKey: string;
  value: unknown;
  wasNumber: boolean;
  error?: string;
  onChange: (v: unknown) => void;
  onError: (msg: string | null) => void;
}) {
  // The saved type decides coercion; the live draft may be a string mid-edit (invalid number).
  const isNumber = wasNumber;
  const editable = wasNumber || typeof value === "string" || typeof value === "number";

  function handleNumber(raw: string) {
    if (raw.trim() === "") {
      onError("กรุณากรอกตัวเลข");
      onChange(raw); // keep raw so the user sees what they typed; save is blocked by the error
      return;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
      onError("ค่าต้องเป็นตัวเลข");
      onChange(raw);
      return;
    }
    onError(null);
    onChange(n);
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{fieldKey}</p>
      {editable ? (
        <>
          <input
            type={isNumber ? "number" : "text"}
            className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={String(value)}
            onChange={(e) => (isNumber ? handleNumber(e.target.value) : onChange(e.target.value))}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </>
      ) : (
        // Arrays/objects stay read-only (no safe inline editor); shown as JSON for reference.
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
