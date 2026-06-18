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
  cancelledAt: string | null;
  checkinMethod: string | null;
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

// Which reason-gated action the dialog is currently driving.
type Action =
  | { kind: "cancel" }
  | { kind: "promote" }
  | { kind: "demote" }
  | { kind: "qr_regenerate" }
  | { kind: "qr_revoke" }
  | { kind: "edit_answers" };

const ACTION_META: Record<
  Action["kind"],
  { title: string; description: string; confirm: string; destructive?: boolean }
> = {
  cancel: {
    title: "ยกเลิกการลงทะเบียน",
    description: "ตั้งค่าการลงทะเบียนเป็นยกเลิกและเพิกถอน QR ที่ใช้งานอยู่",
    confirm: "ยกเลิกการลงทะเบียน",
    destructive: true,
  },
  promote: {
    title: "เลื่อนขึ้นจากรายชื่อสำรอง",
    description: "ย้ายการลงทะเบียนจากรายชื่อสำรองไปเป็นลงทะเบียนแล้วและออก QR",
    confirm: "เลื่อนขึ้น",
  },
  demote: {
    title: "ลดลงไปยังรายชื่อสำรอง",
    description: "ย้ายการลงทะเบียนกลับไปยังรายชื่อสำรองและเพิกถอน QR",
    confirm: "ลดลง",
  },
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
};

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
      case "cancel":
        await apiPost(`${base}/cancel`, { reason });
        break;
      case "promote":
        await apiPost(`${base}/promote`, { reason });
        break;
      case "demote":
        await apiPost(`${base}/demote`, { reason });
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
    }
    toast.success("เสร็จสิ้น มีการบันทึกไว้ในบันทึกการตรวจสอบ");
    await load();
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
          {status === "waitlisted" ? (
            <Button variant="outline" size="sm" onClick={() => setAction({ kind: "promote" })}>
              เลื่อนขึ้น
            </Button>
          ) : null}
          {status === "registered" ? (
            <Button variant="outline" size="sm" onClick={() => setAction({ kind: "demote" })}>
              ลดลง
            </Button>
          ) : null}
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
          {status !== "cancelled" ? (
            <Button variant="destructive" size="sm" onClick={() => setAction({ kind: "cancel" })}>
              ยกเลิก
            </Button>
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
          <Detail label="ยกเลิกแล้ว" value={formatBangkok(reg.cancelledAt) || "—"} />
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
        title={action ? ACTION_META[action.kind].title : ""}
        description={action ? ACTION_META[action.kind].description : undefined}
        confirmLabel={action ? ACTION_META[action.kind].confirm : "ยืนยัน"}
        destructive={action ? ACTION_META[action.kind].destructive : false}
        onConfirm={runAction}
      />
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
