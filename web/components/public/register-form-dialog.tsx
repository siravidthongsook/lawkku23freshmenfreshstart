"use client";

// Public registration form step. Renders the event's active form fields, validates locally, then
// hands the answer map back to the parent which POSTs { answers } to /events/:id/register.
// NOTE: there is NO pre-registration upload endpoint (uploads need a registrationId that only exists
// AFTER register — see docs/02 §Uploads). So file fields cannot be satisfied here: a REQUIRED file
// field blocks submit with a clear message; the student edits answers post-register to attach files.
import { useMemo, useState } from "react";
import { isFileField, validateAnswers, type FormSchema, type AnswerMap } from "@/lib/schemas";
import { FormFieldInput } from "@/components/student/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: FormSchema;
  eventTitle: string;
  submitting: boolean;
  onSubmit: (answers: AnswerMap) => void;
  // Optional seed — used to restore answers preserved across a mid-session login redirect.
  initialValues?: AnswerMap;
  // Optional banner — e.g. "capacity changed while you were filling the form" after a failed submit.
  notice?: string;
};

export function RegisterFormDialog({
  open,
  onOpenChange,
  schema,
  eventTitle,
  submitting,
  onSubmit,
  initialValues,
  notice,
}: Props) {
  const [values, setValues] = useState<AnswerMap>(initialValues ?? {});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // PDPA consent — required gate; collects per-event personal data so consent must precede submit.
  const [pdpaAgreed, setPdpaAgreed] = useState(false);

  // Sorted fields; file fields can't be uploaded pre-registration (no registrationId yet).
  const fields = useMemo(() => [...schema.fields].sort((a, b) => a.sort - b.sort), [schema]);
  const requiredFileFields = useMemo(
    () => schema.fields.filter((f) => isFileField(f) && f.required),
    [schema],
  );
  const hasFileField = useMemo(() => schema.fields.some(isFileField), [schema]);
  const blockedByFile = requiredFileFields.length > 0;

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit() {
    if (blockedByFile) return; // guard: required file field can't be satisfied pre-registration
    if (!pdpaAgreed) return; // guard: PDPA consent required before collecting personal data
    setFieldErrors({});
    const result = validateAnswers(schema, values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    onSubmit(result.values);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ลงทะเบียนกิจกรรม {eventTitle}</DialogTitle>
          <DialogDescription>กรุณากรอกแบบฟอร์มการลงทะเบียนด้านล่าง</DialogDescription>
        </DialogHeader>

        {/* Capacity/state changed under the student between opening the form and submitting. */}
        {notice ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>
        ) : null}

        {/* Backend gap: file uploads require a registration to exist first. */}
        {blockedByFile ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            แบบฟอร์มนี้ต้องการอัปโหลดไฟล์ ซึ่งยังไม่รองรับในระหว่างการลงทะเบียน
            กรุณาติดต่อผู้จัดกิจกรรม
          </p>
        ) : null}

        <div className="space-y-5 py-1">
          {fields.map((field) =>
            isFileField(field) ? (
              // Optional file field: shown but not collectable here; attach after registering.
              <div key={field.key} className="space-y-1">
                <p className="text-sm font-medium">{field.label}</p>
                <p className="text-xs text-muted-foreground">
                  คุณสามารถแนบไฟล์นี้ได้หลังจากลงทะเบียน ผ่านหน้าการลงทะเบียนของคุณ
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

        {/* PDPA consent — required gate. Links to KKU privacy policy; submit stays disabled until checked. */}
        {!blockedByFile ? (
          <label htmlFor="register-pdpa" className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <input
              id="register-pdpa"
              type="checkbox"
              checked={pdpaAgreed}
              onChange={(e) => setPdpaAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
            />
            <span>
              ข้าพเจ้ายินยอมให้เก็บรวบรวมและใช้ข้อมูลส่วนบุคคลตาม{" "}
              <a
                href="https://iad.kku.ac.th/page.php?id=94"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline underline-offset-4"
              >
                นโยบายความเป็นส่วนตัว (PDPA)
              </a>{" "}
              ของกิจกรรม
            </span>
          </label>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            ยกเลิก
          </Button>
          <Button disabled={submitting || blockedByFile || !pdpaAgreed} onClick={handleSubmit}>
            {submitting ? "กำลังลงทะเบียน…" : "ส่งและลงทะเบียน"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
