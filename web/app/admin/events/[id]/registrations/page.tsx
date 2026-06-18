"use client";

// Registration List (dashboard L2). GET /admin/events/:id/registrations.
// Backend now enriches each row with user identity (student_id/full_name/faculty/department),
// the check-in actor's name, and the form version number, and supports server-side search/filter/paging.
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { RegistrationListItem, RegistrationStatus } from "@/lib/types";
import {
  formSchema,
  isFileField,
  validateAnswers,
  type AnswerMap,
  type FormSchema,
} from "@/lib/schemas";
import { regStatusLabel } from "@/lib/labels";
import { FormFieldInput } from "@/components/student/form-fields";
import { formatBangkok } from "@/lib/time";
import { RegistrationStatusBadge } from "@/components/badges";
import { UserPicker } from "@/components/admin-tools/user-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const PAGE_SIZE = 50;

type ListResponse = {
  registrations: RegistrationListItem[];
  total: number;
  limit: number;
  offset: number;
};

const STATUS_OPTIONS: { value: "all" | RegistrationStatus; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "registered", label: regStatusLabel("registered") },
  { value: "waitlisted", label: regStatusLabel("waitlisted") },
  { value: "checked_in", label: regStatusLabel("checked_in") },
  { value: "cancelled", label: regStatusLabel("cancelled") },
];

export default function EventRegistrationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<RegistrationListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | RegistrationStatus>("all");
  const [offset, setOffset] = useState(0);
  const [refetching, setRefetching] = useState(false);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (opts?.silent) setRefetching(true);
      setError(null);
      const sp = new URLSearchParams();
      if (q.trim()) sp.set("q", q.trim());
      if (status !== "all") sp.set("status", status);
      sp.set("limit", String(PAGE_SIZE));
      sp.set("offset", String(offset));
      try {
        const res = await apiGet<ListResponse>(`/admin/events/${id}/registrations?${sp.toString()}`);
        setRows(res.registrations ?? []);
        setTotal(res.total ?? res.registrations?.length ?? 0);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดการลงทะเบียนได้");
        setRows([]);
        setTotal(0);
      } finally {
        setRefetching(false);
      }
    },
    [id, q, status, offset],
  );

  // Reset to page 0 when filters change.
  useEffect(() => {
    setOffset(0);
  }, [q, status]);

  // Debounce search/filter; first paint loads immediately.
  const first = useRef(true);
  useEffect(() => {
    const isFirst = first.current;
    const t = setTimeout(
      () => {
        first.current = false;
        void load({ silent: !isFirst });
      },
      isFirst ? 0 : 300,
    );
    return () => clearTimeout(t);
  }, [load]);

  // Refetch on focus → catch staff/student mutations that happened in another tab.
  useEffect(() => {
    const onFocus = () => void load({ silent: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/events/${id}`}>
              <ArrowLeft className="size-4" />
              ย้อนกลับ
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">การลงทะเบียน</h1>
        </div>
        <Button onClick={() => setManualOpen(true)}>
          <UserPlus className="size-4" />
          ลงทะเบียนด้วยตนเอง
        </Button>
      </div>

      {/* Server-side search + status filter. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="reg-q" className="flex items-center gap-2 text-xs">
            ค้นหา
            {refetching ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
          </Label>
          <Input
            id="reg-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="รหัสนักศึกษา อีเมล หรือชื่อ"
            className="w-64"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">สถานะ</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as "all" | RegistrationStatus)}>
            <SelectTrigger className="w-44">
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
      </div>

      {error ? (
        <div className="rounded-md border py-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => load()}>
            ลองใหม่
          </Button>
        </div>
      ) : rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          {q.trim() || status !== "all" ? "ไม่พบการลงทะเบียนที่ตรงกัน" : "ยังไม่มีการลงทะเบียน"}
        </div>
      ) : (
        <>
          <div className={`rounded-md border ${refetching ? "opacity-60 transition-opacity" : ""}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>รหัสนักศึกษา</TableHead>
                  <TableHead>ชื่อ</TableHead>
                  <TableHead>คณะ</TableHead>
                  <TableHead>สาขา</TableHead>
                  <TableHead>สถานะ</TableHead>
                  <TableHead>ลงทะเบียน</TableHead>
                  <TableHead>เช็คอินแล้ว</TableHead>
                  <TableHead>เช็คอินโดย</TableHead>
                  <TableHead>เวอร์ชันฟอร์ม</TableHead>
                  <TableHead className="text-right">การกระทำ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono">{r.studentId ?? "—"}</TableCell>
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
                      {r.formVersion != null ? `v${r.formVersion}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/admin/registrations/${r.id}`}>ดู</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination (server-side; total gates Next). */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              กำลังแสดง {offset + 1}–{offset + rows.length} จาก {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || refetching}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                ก่อนหน้า
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + rows.length >= total || refetching}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                ถัดไป
              </Button>
            </div>
          </div>
        </>
      )}

      <ManualRegisterDialog
        eventId={id}
        open={manualOpen}
        onOpenChange={setManualOpen}
        onDone={() => load({ silent: true })}
      />
    </div>
  );
}

// Manual register (override window/capacity). userId (via typeahead) + reason REQUIRED.
// POST /admin/events/:id/registrations. Renders the event's active form so the admin answers on
// behalf of the user; backend validates against the active form.
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

  // Active form (null = formless event). loadingForm guards the initial fetch on open.
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [loadingForm, setLoadingForm] = useState(false);
  const [values, setValues] = useState<AnswerMap>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Fetch the active form whenever the dialog opens; parse with the shared validator.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingForm(true);
    (async () => {
      try {
        const { form } = await apiGet<{ form: { schemaJson: unknown } | null }>(
          `/admin/events/${eventId}/form`,
        );
        if (cancelled) return;
        const parsed = form ? formSchema.safeParse(form.schemaJson) : null;
        setSchema(parsed?.success && parsed.data.fields.length > 0 ? parsed.data : null);
      } catch (err) {
        if (cancelled) return;
        setSchema(null);
        toast.error(err instanceof ApiError ? err.message : "ไม่สามารถโหลดแบบฟอร์มของกิจกรรมได้");
      } finally {
        if (!cancelled) setLoadingForm(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  const fields = useMemo(
    () => (schema ? [...schema.fields].sort((a, b) => a.sort - b.sort) : []),
    [schema],
  );
  const requiredFileFields = useMemo(
    () => (schema ? schema.fields.filter((f) => isFileField(f) && f.required) : []),
    [schema],
  );
  const hasFileField = useMemo(() => (schema ? schema.fields.some(isFileField) : false), [schema]);

  // Required-file forms CAN be manual-registered now: we register, then prompt the admin to have the
  // user attach the file afterward (file upload needs an existing registration first).
  const hasRequiredFile = requiredFileFields.length > 0;

  // userId + reason required (reason is the audited override justification).
  const valid = userId.trim() !== "" && reason.trim() !== "" && !loadingForm;

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function reset() {
    setUserId("");
    setReason("");
    setSchema(null);
    setValues({});
    setFieldErrors({});
  }

  async function submit() {
    if (!valid || submitting) return;

    // Validate non-file answers locally first. Required FILE fields are skipped here (no registration
    // yet to attach to) — backend treats a missing file value as acceptable for manual register.
    let answers: AnswerMap = {};
    if (schema) {
      setFieldErrors({});
      const result = validateAnswers(schema, values);
      if (!result.ok) {
        // Drop errors that are only about required file fields — those are handled post-registration.
        const fileKeys = new Set(requiredFileFields.map((f) => f.key));
        const blocking = Object.fromEntries(
          Object.entries(result.errors).filter(([k]) => !fileKeys.has(k)),
        );
        if (Object.keys(blocking).length > 0) {
          setFieldErrors(blocking);
          return;
        }
        // Only required-file errors remained → send the collected non-file answers as-is.
        answers = values;
      } else {
        answers = result.values;
      }
    }

    setSubmitting(true);
    try {
      await apiPost(`/admin/events/${eventId}/registrations`, {
        userId: userId.trim(),
        reason: reason.trim(),
        answers,
      });
      if (hasRequiredFile) {
        toast.success("ลงทะเบียนผู้ใช้แล้ว", {
          description: "แบบฟอร์มนี้ต้องการไฟล์ — แจ้งให้ผู้ใช้แนบไฟล์จากหน้าการลงทะเบียนของตนเอง",
        });
      } else {
        toast.success("ลงทะเบียนผู้ใช้แล้ว");
      }
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถลงทะเบียนผู้ใช้ได้");
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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ลงทะเบียนด้วยตนเอง</DialogTitle>
          <DialogDescription>
            ข้ามช่วงเวลาลงทะเบียนและจำนวนที่รับ มีการบันทึกไว้ในบันทึกการตรวจสอบ
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>ผู้ใช้</Label>
            {/* Typeahead by student id / email / name — no raw UUID typing. */}
            <UserPicker eventId={eventId} value={userId} onChange={(uid) => setUserId(uid)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-reason">
              เหตุผล <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="manual-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            {/* Explain WHY reason is required so the disabled submit isn't a mystery. */}
            <p className="text-xs text-muted-foreground">
              จำเป็น เพราะการลงทะเบียนด้วยตนเองเป็นการข้ามช่วงเวลา/จำนวนที่รับ
              และถูกบันทึกไว้ในบันทึกการตรวจสอบ
            </p>
          </div>

          {/* Form answers (only when the event has an active form). */}
          {loadingForm ? (
            <Skeleton className="h-24 w-full" />
          ) : schema ? (
            <div className="space-y-4 border-t pt-3">
              <p className="text-sm font-medium">แบบฟอร์มการลงทะเบียน</p>

              {hasRequiredFile ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  แบบฟอร์มนี้มีไฟล์ที่จำเป็น ระบบจะลงทะเบียนผู้ใช้ก่อน
                  จากนั้นผู้ใช้ต้องแนบไฟล์เองจากหน้าการลงทะเบียนของตน
                </p>
              ) : null}

              {fields.map((field) =>
                isFileField(field) ? (
                  <div key={field.key} className="space-y-1">
                    <p className="text-sm font-medium">
                      {field.label}
                      {field.required ? <span className="text-destructive"> *</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ผู้ใช้สามารถแนบไฟล์นี้ได้หลังจากลงทะเบียน
                    </p>
                  </div>
                ) : (
                  <FormFieldInput
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    error={fieldErrors[field.key]}
                    onChange={setValue}
                  />
                ),
              )}
              {hasFileField && !hasRequiredFile ? (
                <p className="text-xs text-muted-foreground">
                  สามารถเพิ่มไฟล์อัปโหลดได้หลังจากลงทะเบียน
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            ยกเลิก
          </Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? "กำลังดำเนินการ…" : "ลงทะเบียน"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
