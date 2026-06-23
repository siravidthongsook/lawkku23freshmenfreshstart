"use client";

// Shared walk-in register dialog used by BOTH the staff check-in gate (checkinNow=true: create +
// register + check-in) and the admin desk (checkinNow=false: create + register only). One endpoint:
// POST /events/:eventId/walkin. Flow: fill form -> dry_run:true preview -> confirm dialog showing the
// resolved identity + whether it will check in -> on confirm dry_run:false commit -> result screen.
//
// SAFETY: we NEVER synthesize success. Only a real 2xx WalkinRegisterResponse from the server is a success;
// any ApiError (incl. 409 user_exists) is shown as a friendly message and nothing is treated as committed.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
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
// Backend Zod-inferred response shapes — single source of truth (types only, erased at build).
import type { WalkinRegisterResponse, WalkinLookupResponse } from "@be/modules/registrations/routes";

// Thai labels for an existing account's prior registration state (drives the confirm-screen banner).
const REG_STATUS_LABEL: Record<
  WalkinRegisterResponse["matchedExisting"]["existingRegStatus"],
  string
> = {
  none: "ยังไม่ลงทะเบียน",
  registered: "ลงทะเบียนแล้ว",
  checked_in: "เช็คอินแล้ว",
  cancelled: "ยกเลิก",
  waitlisted: "รอคิว",
};

// Inline-card reg-status line for the auto-detected existing account (early hint while typing).
// cancelled/waitlisted carry a "(จะกู้คืน)" suffix built at render time.
const LOOKUP_REG_STATUS_LABEL: Record<WalkinLookupResponse["existingRegStatus"], string> = {
  none: "ยังไม่ลงทะเบียน",
  registered: "ลงทะเบียนแล้ว",
  checked_in: "เช็คอินแล้ว",
  cancelled: "ยกเลิก",
  waitlisted: "รอคิว",
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
  confirmReuse: boolean,
  reuseExisting: boolean, // omit full_name when reusing — backend ignores it on reuse, keep body clean
) {
  return {
    full_name: reuseExisting ? undefined : f.full_name.trim(),
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
    // Reuse an existing matched account on commit; preview never confirms (dry_run shows the identity first).
    confirm_reuse: confirmReuse,
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

  // Auto-detect: debounced lookup by student_id. `lookup` is the resolved result (null = not yet resolved).
  // Submit is gated on `!lookingUp` (wait for in-flight detect) — NOT on a successful lookup, so a flaky
  // lookup GET can't hard-block the desk; on lookup error we degrade to the authoritative POST dry_run flow.
  const [lookup, setLookup] = useState<WalkinLookupResponse | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState(false); // detect failed → degrade to manual entry + POST
  // Bumped on every dialog reset so an in-flight debounce/fetch from a previous session is ignored.
  const lookupSeq = useRef(0);

  // Debounce the lookup ~400ms after student_id changes; ignore stale/out-of-order responses by
  // comparing the response's query (sid) against the CURRENT student_id when it lands.
  useEffect(() => {
    const sid = form.student_id.trim();
    const email = form.email.trim();
    if (sid === "") {
      // Idle / cleared — neutral, nothing resolved.
      setLookup(null);
      setLookingUp(false);
      setLookupError(false);
      return;
    }
    const seq = lookupSeq.current;
    setLookingUp(true);
    setLookupError(false);
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ student_id: sid });
      if (email) qs.set("email", email);
      // Stale guard: dialog reset, or student_id/email moved on while fetching → drop this result.
      const stale = () => seq !== lookupSeq.current || sid !== form.student_id.trim() || email !== form.email.trim();
      try {
        const res = await apiGet<WalkinLookupResponse>(`/events/${eventId}/walkin/lookup?${qs.toString()}`);
        if (stale()) return;
        setLookup(res);
      } catch {
        // Best-effort hint — on error flag degrade (submit allowed via full_name + POST), don't crash.
        if (stale()) return;
        setLookup(null);
        setLookupError(true);
      } finally {
        if (!stale()) setLookingUp(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form.student_id, form.email, eventId]);

  // Detection-derived flags. `foundEligible` = reuse an existing student (lock the new-account inputs).
  const foundEligible = lookup?.found === true && lookup.eligible === true;
  const foundIneligible = lookup?.found === true && lookup.eligible === false;
  const isNew = lookup?.found === false; // resolved + not found → creating a new account

  // valid: id+reason present, no in-flight detect, not an ineligible match. full_name required unless an
  // eligible existing student was matched. On lookup error (no match resolved) we fall back to requiring
  // full_name and let the POST dry_run resolve authoritatively — never hard-block the desk on a flaky GET.
  const valid =
    form.student_id.trim() !== "" &&
    reason.trim() !== "" &&
    !lookingUp &&
    !foundIneligible &&
    (foundEligible || form.full_name.trim() !== "");

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
    setLookup(null);
    setLookingUp(false);
    lookupSeq.current += 1; // invalidate any in-flight lookup from the closed session
  }

  // Map backend error codes to friendly Thai. user_exists is the important one — tell staff to use search.
  const friendlyError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "user_exists")
        return checkinNow
          ? "มีบัญชีอยู่แล้วสำหรับรหัส/อีเมลนี้ — ให้ใช้ \"ค้นหาด้วยตนเอง\" เพื่อเช็คอินแทน"
          : "มีบัญชีอยู่แล้วสำหรับรหัส/อีเมลนี้ — ให้ใช้ช่องเพิ่มผู้เข้าร่วมจากผู้ใช้ที่มีอยู่แทน";
      // Matched account is privileged/inactive — walk-in-as-participant is blocked.
      if (err.code === "cannot_walkin_privileged")
        return "บัญชีนี้เป็นเจ้าหน้าที่/แอดมิน ไม่สามารถ walk-in เป็นผู้เข้าร่วมได้";
      if (err.code === "user_inactive") return "บัญชีนี้ถูกระงับ — ติดต่อแอดมิน";
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
        // dry_run never confirms reuse; omit full_name when detect already matched an eligible account.
        buildBody(form, reason, checkinNow, source, true, false, foundEligible),
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
        // Staff is on the confirm screen = they've vetted the matched identity → auto-send confirm_reuse.
        // Reuse is authoritatively decided by the dry-run's matchedExisting (also drives full_name omission).
        buildBody(
          form,
          reason,
          checkinNow,
          source,
          false,
          preview?.matchedExisting?.found ?? false,
          preview?.matchedExisting?.found ?? false,
        ),
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
          <ResultView result={result} onClose={() => handleOpenChange(false)} />
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
              {/* Auto-detect is on: typing the รหัสนักศึกษา probes the system for an existing account. */}
              <p className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>
                  พิมพ์<strong>รหัสนักศึกษา</strong> ระบบจะตรวจสอบให้อัตโนมัติว่ามีบัญชีอยู่แล้วหรือไม่
                </span>
              </p>

              {/* student_id is the FIRST + driving field; the lookup keys off it. */}
              <Field
                label="รหัสนักศึกษา"
                required
                value={form.student_id}
                onChange={(v) => set("student_id", v)}
              />

              {/* Detection state: loading / existing-account card / ineligible block / new-account hint. */}
              {lookingUp ? (
                <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> กำลังตรวจสอบ…
                </p>
              ) : foundEligible && lookup?.user ? (
                // Read-only card of the REAL account data so staff don't need a separate lookup UI.
                <div className="space-y-1.5 rounded-md border border-blue-200 bg-blue-50/60 p-3 text-sm">
                  <p className="flex items-center gap-2 font-medium text-blue-800">
                    <CheckCircle2 className="size-4 shrink-0" /> ข้อมูลนักศึกษาที่มีอยู่ในระบบ
                  </p>
                  <Row label="ชื่อ-นามสกุล" value={lookup.user.full_name} />
                  {lookup.user.group_number != null ? (
                    <Row label="บรรพ" value={String(lookup.user.group_number)} />
                  ) : null}
                  {lookup.user.faculty ? <Row label="คณะ" value={lookup.user.faculty} /> : null}
                  {lookup.user.department ? <Row label="สาขา" value={lookup.user.department} /> : null}
                  {lookup.user.email ? <Row label="อีเมล" value={lookup.user.email} /> : null}
                  <Row
                    label="สถานะการลงทะเบียน"
                    value={
                      lookup.existingRegStatus === "cancelled" || lookup.existingRegStatus === "waitlisted"
                        ? `${LOOKUP_REG_STATUS_LABEL[lookup.existingRegStatus]} (จะกู้คืน)`
                        : LOOKUP_REG_STATUS_LABEL[lookup.existingRegStatus]
                    }
                  />
                </div>
              ) : foundIneligible ? (
                <p className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {lookup?.ineligibleReason === "not_student"
                    ? "บัญชีนี้เป็นเจ้าหน้าที่/แอดมิน ไม่สามารถ walk-in เป็นผู้เข้าร่วมได้"
                    : "บัญชีนี้ถูกระงับ — ติดต่อแอดมิน"}
                </p>
              ) : isNew ? (
                <p className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  ไม่พบในระบบ — จะสร้างบัญชีใหม่
                </p>
              ) : lookupError ? (
                // Detect failed — don't block; let staff fill the form, the POST dry_run resolves authoritatively.
                <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  ตรวจสอบอัตโนมัติไม่สำเร็จ — กรอกชื่อ-นามสกุลแล้วกด “ตรวจสอบ” เพื่อดำเนินการต่อได้
                </p>
              ) : null}

              {/* New-account inputs: disabled when an eligible account was matched (reuse, don't overwrite).
                  full_name lives HERE now — required only when creating a new account. */}
              <p className="pt-1 text-xs font-medium text-muted-foreground">ข้อมูลสำหรับบัญชีใหม่</p>
              <Field
                label="ชื่อ-นามสกุล"
                required={!foundEligible}
                value={form.full_name}
                onChange={(v) => set("full_name", v)}
                disabled={foundEligible}
              />
              <Field
                label="อีเมล"
                value={form.email}
                onChange={(v) => set("email", v)}
                type="email"
                disabled={foundEligible}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label="คณะ" value={form.faculty} onChange={(v) => set("faculty", v)} disabled={foundEligible} />
                <Field
                  label="สาขา"
                  value={form.department}
                  onChange={(v) => set("department", v)}
                  disabled={foundEligible}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="ชื่อเล่น"
                  value={form.nickname}
                  onChange={(v) => set("nickname", v)}
                  disabled={foundEligible}
                />
                <Field
                  label="เบอร์โทร"
                  value={form.phone}
                  onChange={(v) => set("phone", v)}
                  disabled={foundEligible}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* บรรพ = staff-assigned cohort label only (not a claim factor — claim is by student_id). */}
                <div className="space-y-1.5">
                  <Field
                    label="บรรพ"
                    value={form.group_number}
                    onChange={(v) => set("group_number", v)}
                    type="number"
                    disabled={foundEligible}
                  />
                  <p className="text-xs text-muted-foreground">ใช้กับบัญชีใหม่เท่านั้น — บัญชีเดิมจะคงบรรพเดิมไว้</p>
                </div>
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
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  disabled?: boolean; // greyed/locked when reusing an existing account
}) {
  return (
    <div className="space-y-1.5">
      <Label className={disabled ? "text-muted-foreground" : undefined}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
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
  // Stamp always happens now when staff asked for it — closed window no longer skips (gate override).
  const willCheckIn = checkinNow;
  const matched = preview.matchedExisting;
  const regLabel = REG_STATUS_LABEL[matched.existingRegStatus];
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

        {/* Existing-account banners: the identity dl above is the REAL existing data when matched. */}
        {matched.found ? (
          matched.existingRegStatus === "none" ? (
            <p className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <Info className="mt-0.5 size-4 shrink-0" />
              พบบัญชีที่มีอยู่แล้ว — จะใช้บัญชีนี้ (ไม่สร้างใหม่)
            </p>
          ) : matched.existingRegStatus === "registered" ? (
            <p className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <Info className="mt-0.5 size-4 shrink-0" />
              พบบัญชีเดิม ลงทะเบียนไว้แล้ว — จะเช็คอินให้
            </p>
          ) : matched.existingRegStatus === "checked_in" ? (
            <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              บัญชีนี้เช็คอินไปแล้ว — กดยืนยันจะไม่เพิ่มคะแนนซ้ำ
            </p>
          ) : (
            // cancelled | waitlisted → revive then check in
            <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              พบบัญชีเดิม (สถานะ {regLabel}) — จะกู้คืนการลงทะเบียนแล้วเช็คอิน
            </p>
          )
        ) : null}

        {checkinNow ? (
          <p className="flex items-start gap-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            จะลงทะเบียนและเช็คอินทันที
          </p>
        ) : (
          <p className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <Info className="mt-0.5 size-4 shrink-0" />
            จะลงทะเบียนเท่านั้น (ยังไม่เช็คอิน)
          </p>
        )}

        {/* Out-of-window stamp note — only relevant when a check-in will actually happen. */}
        {willCheckIn && preview.pastWindow ? (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            นอกช่วงเวลาเช็คอิน — จะเช็คอินให้ (override)
          </p>
        ) : null}

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

// Result screen after a successful commit. Surfaces points + check-in state + student_id.
// (checkin state is read from the result now — no checkinNow prop needed.)
function ResultView({
  result,
  onClose,
}: {
  result: WalkinRegisterResponse;
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
          // Matched account already checked in earlier → no duplicate points; call it out explicitly.
          result.pointsAwarded === 0 && result.matchedExisting.existingRegStatus === "checked_in" ? (
            <p className="flex items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-green-800">
              <CheckCircle2 className="size-4 shrink-0" />
              เช็คอินอยู่แล้ว (ไม่เพิ่มคะแนนซ้ำ)
            </p>
          ) : (
            <p className="flex items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-green-800">
              <CheckCircle2 className="size-4 shrink-0" />
              เช็คอินแล้ว{result.pastWindow ? " (นอกเวลา)" : ""}
              {result.pointsAwarded > 0 ? ` (+${result.pointsAwarded} คะแนน)` : ""}
            </p>
          )
        ) : (
          // Admin desk (checkinNow=false): registered only, no check-in.
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
