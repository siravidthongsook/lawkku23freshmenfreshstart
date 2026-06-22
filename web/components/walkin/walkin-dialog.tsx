"use client";

// Shared walk-in register dialog used by BOTH the staff check-in gate (checkinNow=true: create +
// register + check-in) and the admin desk (checkinNow=false: create + register only). One endpoint:
// POST /events/:eventId/walkin. Flow: fill form -> dry_run:true preview -> confirm dialog showing the
// resolved identity + whether it will check in -> on confirm dry_run:false commit -> result screen.
//
// SAFETY: we NEVER synthesize success. Only a real 2xx WalkinRegisterResponse from the server is a success;
// any ApiError (incl. 409 user_exists) is shown as a friendly message and nothing is treated as committed.
import { useCallback, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RegistrationSource } from "@/lib/types";
// Backend Zod-inferred response shape — single source of truth (types only, erased at build).
import type { WalkinRegisterResponse } from "@be/modules/registrations/routes";

// Thai labels for the skip reason returned when checkin_now was asked but the window was closed.
const SKIP_LABEL: Record<NonNullable<WalkinRegisterResponse["checkinSkipped"]>, string> = {
  checkin_not_open: "ช่วงเวลาเช็คอินยังไม่เปิด",
  checkin_closed: "ช่วงเวลาเช็คอินปิดแล้ว",
};

type FormState = {
  full_name: string;
  student_id: string;
  email: string;
  faculty: string;
  department: string;
  phone: string;
  nickname: string;
  group_number: string; // บรรพ — kept as string for the input; parsed to int in buildBody
};

const EMPTY: FormState = {
  full_name: "",
  student_id: "",
  email: "",
  faculty: "",
  department: "",
  phone: "",
  nickname: "",
  group_number: "",
};

// Build the request body from the form. Empty optional strings are dropped (schema wants undefined, not "").
// source: staff gate (checkinNow=true) is always a walk-in; admin desk (checkinNow=false) can choose.
function buildBody(
  f: FormState,
  reason: string,
  checkinNow: boolean,
  source: RegistrationSource,
  dryRun: boolean,
) {
  return {
    full_name: f.full_name.trim(),
    student_id: f.student_id.trim(),
    email: f.email.trim() || undefined,
    faculty: f.faculty.trim() || undefined,
    department: f.department.trim() || undefined,
    phone: f.phone.trim() || undefined,
    nickname: f.nickname.trim() || undefined,
    group_number: f.group_number.trim() ? Number(f.group_number.trim()) : undefined,
    reason: reason.trim(),
    source: checkinNow ? "walkin" : source,
    checkin_now: checkinNow,
    dry_run: dryRun,
  };
}

export function WalkinDialog({
  eventId,
  open,
  onOpenChange,
  checkinNow,
  onDone,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // true = staff gate (also check in now); false = admin desk (register only).
  checkinNow: boolean;
  onDone: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [reason, setReason] = useState("");
  // Registration provenance — only editable on the admin desk; gate flow forces "walkin" in buildBody.
  const [source, setSource] = useState<RegistrationSource>("walkin");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview from the dry-run; while set we show the confirm screen instead of the form.
  const [preview, setPreview] = useState<WalkinRegisterResponse | null>(null);
  // Final committed result; while set we show the result screen.
  const [result, setResult] = useState<WalkinRegisterResponse | null>(null);

  const valid = form.full_name.trim() !== "" && form.student_id.trim() !== "" && reason.trim() !== "";

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function reset() {
    setForm(EMPTY);
    setReason("");
    setSource("walkin");
    setError(null);
    setPreview(null);
    setResult(null);
    setSubmitting(false);
  }

  // Map backend error codes to friendly Thai. user_exists is the important one — tell staff to use search.
  const friendlyError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "user_exists")
        return checkinNow
          ? "มีบัญชีอยู่แล้วสำหรับรหัส/อีเมลนี้ — ให้ใช้ \"ค้นหาด้วยตนเอง\" เพื่อเช็คอินแทน"
          : "มีบัญชีอยู่แล้วสำหรับรหัส/อีเมลนี้ — ให้ใช้ช่องเพิ่มผู้เข้าร่วมจากผู้ใช้ที่มีอยู่แทน";
      if (err.code === "event_not_published") return "กิจกรรมนี้ยังไม่ได้เผยแพร่";
      if (err.code === "no_active_form") return "กิจกรรมนี้ยังไม่มีแบบฟอร์มที่ใช้งานอยู่";
      if (err.code === "invalid_form_answers") return "คำตอบแบบฟอร์มไม่ถูกต้อง";
      return err.message;
    }
    return "ไม่สามารถดำเนินการได้";
  }, [checkinNow]);

  // Step 1: dry-run preview. On success we move to the confirm screen.
  async function runPreview() {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<WalkinRegisterResponse>(
        `/events/${eventId}/walkin`,
        buildBody(form, reason, checkinNow, source, true),
      );
      setPreview(res);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2: confirmed — commit (dry_run:false). On success we show the result screen + refresh the list.
  async function commit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<WalkinRegisterResponse>(
        `/events/${eventId}/walkin`,
        buildBody(form, reason, checkinNow, source, false),
      );
      setResult(res);
      onDone();
    } catch (err) {
      // Commit failed — drop back to the form view with the error (preview cleared so they can re-check).
      setPreview(null);
      setError(friendlyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (submitting) return; // don't close mid-request
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {/* THREE views: result (committed) > preview (confirm) > form (default). */}
        {result ? (
          <ResultView result={result} checkinNow={checkinNow} onClose={() => handleOpenChange(false)} />
        ) : preview ? (
          <PreviewView
            preview={preview}
            checkinNow={checkinNow}
            submitting={submitting}
            error={error}
            onBack={() => setPreview(null)}
            onConfirm={commit}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{checkinNow ? "เพิ่ม Walk-in" : "เพิ่มผู้เข้าร่วมใหม่"}</DialogTitle>
              <DialogDescription>
                {checkinNow
                  ? "สร้างบัญชีนักศึกษาใหม่ ลงทะเบียน และเช็คอินทันที (นักศึกษาเรียกร้องบัญชีภายหลังด้วยรหัสนักศึกษา)"
                  : "สร้างบัญชีนักศึกษาใหม่และลงทะเบียนให้ (ยังไม่เช็คอิน)"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <Field label="ชื่อ-นามสกุล" required value={form.full_name} onChange={(v) => set("full_name", v)} />
              <Field
                label="รหัสนักศึกษา"
                required
                value={form.student_id}
                onChange={(v) => set("student_id", v)}
              />
              <Field label="อีเมล" value={form.email} onChange={(v) => set("email", v)} type="email" />
              <div className="grid grid-cols-2 gap-3">
                <Field label="คณะ" value={form.faculty} onChange={(v) => set("faculty", v)} />
                <Field label="สาขา" value={form.department} onChange={(v) => set("department", v)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="ชื่อเล่น" value={form.nickname} onChange={(v) => set("nickname", v)} />
                <Field label="เบอร์โทร" value={form.phone} onChange={(v) => set("phone", v)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* บรรพ = group 1..16; staff-assigned, used later as the account-claim 2nd factor. */}
                <Field label="บรรพ" value={form.group_number} onChange={(v) => set("group_number", v)} type="number" />
                <div />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="walkin-reason">
                  เหตุผล <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="walkin-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="เช่น ลงทะเบียนหน้างาน"
                />
                {/* Explain WHY reason is required so the disabled submit isn't a mystery. */}
                <p className="text-xs text-muted-foreground">
                  จำเป็น — บันทึกไว้ในบันทึกการตรวจสอบ (audit log)
                </p>
              </div>

              {/* Source is editable only at the admin desk; the staff gate is always a walk-in. */}
              {!checkinNow ? (
                <div className="space-y-1.5">
                  <Label>ที่มาการลงทะเบียน</Label>
                  <Select value={source} onValueChange={(v) => setSource(v as RegistrationSource)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">ปกติ</SelectItem>
                      <SelectItem value="walkin">Walk-in</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {error ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                ยกเลิก
              </Button>
              <Button onClick={runPreview} disabled={!valid || submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                ตรวจสอบ
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// One labelled text input. Optional fields render without the required asterisk.
function Field({
  label,
  value,
  onChange,
  required,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// Confirm screen: shows the resolved identity from the dry-run + whether check-in will happen.
function PreviewView({
  preview,
  checkinNow,
  submitting,
  error,
  onBack,
  onConfirm,
}: {
  preview: WalkinRegisterResponse;
  checkinNow: boolean;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  // When staff asked to check in but the window is closed, the reg will still be created (no check-in).
  const willCheckIn = checkinNow && !preview.checkinSkipped;
  return (
    <>
      <DialogHeader>
        <DialogTitle>ยืนยันข้อมูล</DialogTitle>
        <DialogDescription>ตรวจสอบตัวตนก่อนบันทึก</DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <dl className="space-y-1.5 rounded-md border p-3 text-sm">
          <Row label="ชื่อ" value={preview.user.full_name} />
          <Row label="รหัสนักศึกษา" value={preview.user.student_id ?? "—"} mono />
          {preview.user.email ? <Row label="อีเมล" value={preview.user.email} /> : null}
          {preview.user.faculty ? <Row label="คณะ" value={preview.user.faculty} /> : null}
          {preview.user.department ? <Row label="สาขา" value={preview.user.department} /> : null}
          {preview.user.group_number != null ? (
            <Row label="บรรพ" value={String(preview.user.group_number)} />
          ) : null}
        </dl>

        {checkinNow ? (
          willCheckIn ? (
            <p className="flex items-start gap-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              จะลงทะเบียนและเช็คอินทันที
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {preview.checkinSkipped ? SKIP_LABEL[preview.checkinSkipped] : "ช่วงเวลาเช็คอินปิดอยู่"} —
              จะลงทะเบียนแต่ <strong>ยังไม่เช็คอิน</strong> (เช็คอินภายหลังได้)
            </p>
          )
        ) : (
          <p className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <Info className="mt-0.5 size-4 shrink-0" />
            จะลงทะเบียนเท่านั้น (ยังไม่เช็คอิน)
          </p>
        )}

        {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          แก้ไข
        </Button>
        <Button onClick={onConfirm} disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          ยืนยันบันทึก
        </Button>
      </DialogFooter>
    </>
  );
}

// Result screen after a successful commit. Surfaces points + the check-in-skipped warning + student_id.
function ResultView({
  result,
  checkinNow,
  onClose,
}: {
  result: WalkinRegisterResponse;
  checkinNow: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-green-600" />
          บันทึกสำเร็จ
        </DialogTitle>
        <DialogDescription>{result.user.full_name}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        {/* student_id is highlighted: staff must tell the student this is how they claim their account later. */}
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">รหัสนักศึกษา (ใช้เรียกร้องบัญชีภายหลัง)</p>
          <p className="font-mono text-lg font-semibold">{result.user.student_id ?? "—"}</p>
        </div>

        {result.checkedIn ? (
          <p className="flex items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-green-800">
            <CheckCircle2 className="size-4 shrink-0" />
            เช็คอินแล้ว {result.pointsAwarded > 0 ? `(+${result.pointsAwarded} คะแนน)` : ""}
          </p>
        ) : checkinNow ? (
          // IMPORTANT: registered but NOT checked in because the window was closed — make this loud.
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            ลงทะเบียนแล้วแต่ <strong>ยังไม่เช็คอิน</strong> เพราะ
            {result.checkinSkipped ? ` ${SKIP_LABEL[result.checkinSkipped]}` : "ช่วงเวลาเช็คอินปิดอยู่"} —
            เช็คอินให้นักศึกษาภายหลังได้
          </p>
        ) : (
          <p className="flex items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-blue-800">
            <Info className="size-4 shrink-0" />
            ลงทะเบียนแล้ว (ยังไม่เช็คอิน)
          </p>
        )}
      </div>

      <DialogFooter>
        <Button onClick={onClose}>เสร็จสิ้น</Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : ""}>{value}</dd>
    </div>
  );
}
