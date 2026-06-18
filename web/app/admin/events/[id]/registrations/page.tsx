"use client";

// Registration List (dashboard L2). GET /admin/events/:id/registrations.
// NOTE: backend serializeRegistration currently returns reg-level fields only (no user profile / checked_in_by
// label / form_version label). We render those columns from the row when present and fall back to "—".
import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import type { RegistrationListItem } from "@/lib/types";
import {
  formSchema,
  isFileField,
  validateAnswers,
  type AnswerMap,
  type FormSchema,
} from "@/lib/schemas";
import { FormFieldInput } from "@/components/student/form-fields";
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
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดการลงทะเบียนได้");
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

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          ยังไม่มีการลงทะเบียน
        </div>
      ) : (
        <div className="rounded-md border">
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
                <TableHead>โดย</TableHead>
                <TableHead>เวอร์ชันฟอร์ม</TableHead>
                <TableHead className="text-right">การกระทำ</TableHead>
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
                      <Link href={`/admin/registrations/${r.id}`}>ดู</Link>
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
// Renders the event's active form fields so the admin can answer on behalf of the user — backend
// validates answers against the active form (required fields enforced), so {} fails for forms w/ required fields.
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
        // Treat null form / parse failure / zero fields as a formless event (submit answers: {}).
        setSchema(parsed?.success && parsed.data.fields.length > 0 ? parsed.data : null);
      } catch (err) {
        if (cancelled) return;
        setSchema(null);
        toast.error(
          err instanceof ApiError ? err.message : "ไม่สามารถโหลดแบบฟอร์มของกิจกรรมได้",
        );
      } finally {
        if (!cancelled) setLoadingForm(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  // Sorted non-file fields + file-field handling mirrors the public register dialog.
  const fields = useMemo(
    () => (schema ? [...schema.fields].sort((a, b) => a.sort - b.sort) : []),
    [schema],
  );
  const requiredFileFields = useMemo(
    () => (schema ? schema.fields.filter((f) => isFileField(f) && f.required) : []),
    [schema],
  );
  const hasFileField = useMemo(
    () => (schema ? schema.fields.some(isFileField) : false),
    [schema],
  );
  // Required file fields can't be satisfied pre-registration (no registrationId yet) — block submit.
  const blockedByFile = requiredFileFields.length > 0;

  // Both fields required — reason is mandatory (audited override). File-blocked forms can't submit.
  const valid =
    userId.trim() !== "" && reason.trim() !== "" && !loadingForm && !blockedByFile;

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

    // Validate answers locally first (only when the event has a form).
    let answers: AnswerMap = {};
    if (schema) {
      setFieldErrors({});
      const result = validateAnswers(schema, values);
      if (!result.ok) {
        setFieldErrors(result.errors);
        return;
      }
      answers = result.values;
    }

    setSubmitting(true);
    try {
      await apiPost(`/admin/events/${eventId}/registrations`, {
        userId: userId.trim(),
        reason: reason.trim(),
        answers, // real answer map (or {} for formless events); backend validates against active form
      });
      toast.success("ลงทะเบียนผู้ใช้แล้ว");
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
            <Label htmlFor="userId">รหัสผู้ใช้ (UUID)</Label>
            <Input
              id="userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
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
          </div>

          {/* Form answers (only when the event has an active form). */}
          {loadingForm ? (
            <Skeleton className="h-24 w-full" />
          ) : schema ? (
            <div className="space-y-4 border-t pt-3">
              <p className="text-sm font-medium">แบบฟอร์มการลงทะเบียน</p>

              {/* Backend gap: file uploads require a registration to exist first. */}
              {blockedByFile ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  แบบฟอร์มนี้ต้องการอัปโหลดไฟล์ ซึ่งยังไม่รองรับในระหว่างการลงทะเบียน
                  ผู้ใช้ต้องแนบไฟล์เองหลังลงทะเบียน
                </p>
              ) : null}

              {fields.map((field) =>
                isFileField(field) ? (
                  // Optional file field: shown but not collectable here; user attaches after registering.
                  <div key={field.key} className="space-y-1">
                    <p className="text-sm font-medium">{field.label}</p>
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
              {hasFileField && !blockedByFile ? (
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
