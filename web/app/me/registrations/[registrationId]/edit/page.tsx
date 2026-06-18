"use client";

// /me/registrations/:id/edit — edit answers on the registration's OWN form version.
// Flow: load detail → extract its form schema → render fields seeded with current answers →
// validate locally → upload any newly-picked files (multipart, replaces old) → PATCH answers (JSON).
// Allowed only when event permits edit + before deadline + not checked_in (backend is source of truth).
import { useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPatch, apiPostForm, ApiError } from "@/lib/api";
import { isFileField, validateAnswers, type FormSchema, type AnswerMap } from "@/lib/schemas";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { FormFieldInput, FileField } from "@/components/student/form-fields";
import {
  extractFormSchema,
  canOfferEdit,
  editDisallowedReason,
} from "@/components/student/detail-helpers";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { RegistrationDetailResponse } from "@/components/student/types";

// Upload response from POST /registrations/:id/files (snake_case per uploads route).
type UploadResponse = { id: string };

function EditInner({ registrationId }: { registrationId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<RegistrationDetailResponse | null>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<AnswerMap>({});
  const [pendingFiles, setPendingFiles] = useState<Record<string, File | null>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [initialAnswers, setInitialAnswers] = useState<AnswerMap>({}); // snapshot for dirty tracking
  // File field the student is about to replace — confirm before overwriting the existing upload.
  const [replaceConfirm, setReplaceConfirm] = useState<{ key: string; file: File } | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<RegistrationDetailResponse>(`/me/registrations/${registrationId}`)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setSchema(extractFormSchema(d));
        setValues({ ...(d.answers ?? {}) }); // seed with current answers
        setInitialAnswers({ ...(d.answers ?? {}) });
      })
      .catch((e) => {
        if (active) setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการลงทะเบียนได้");
      });
    return () => {
      active = false;
    };
  }, [registrationId]);

  // Sorted fields; file fields rendered via FileField (uploaded separately from JSON answers).
  const fields = useMemo(
    () => (schema ? [...schema.fields].sort((a, b) => a.sort - b.sort) : []),
    [schema],
  );

  // Dirty when any answer changed from the loaded snapshot OR a new file is staged. Drives the leave-warning
  // and disables the save button when there is nothing to save.
  const dirty = useMemo(() => {
    if (Object.values(pendingFiles).some(Boolean)) return true;
    return JSON.stringify(values) !== JSON.stringify(initialAnswers);
  }, [values, initialAnswers, pendingFiles]);

  useUnsavedChanges(dirty && !saving); // don't warn while a save is in flight (navigating away is intentional)

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }
  function pickFile(key: string, file: File | null) {
    // Replacing an existing upload → confirm first (overwrites the old file). Clearing/first upload: no confirm.
    const hasExisting = typeof values[key] === "string" && (values[key] as string).length > 0;
    if (file && hasExisting) {
      setReplaceConfirm({ key, file });
      return;
    }
    setPendingFiles((prev) => ({ ...prev, [key]: file }));
  }

  async function handleSave() {
    if (!schema) return;
    setFieldErrors({});

    // 1) VALIDATE FIRST — before any upload — so a failed validation never leaves files persisted server-side.
    // A file field is "satisfied" if it already has an id OR has a freshly-picked file pending upload.
    // We seed those pending file fields with a placeholder id so validateAnswers treats them as present;
    // the real id replaces it after upload below.
    const PENDING = "__pending_upload__";
    const preValues: AnswerMap = { ...values };
    for (const field of schema.fields) {
      if (isFileField(field) && pendingFiles[field.key]) preValues[field.key] = PENDING;
    }
    const preCheck = validateAnswers(schema, preValues);
    if (!preCheck.ok) {
      setFieldErrors(preCheck.errors);
      toast.error("กรุณาแก้ไขช่องที่ถูกไฮไลต์");
      return;
    }

    setSaving(true);
    try {
      // 2) Upload newly-picked files; the returned file id becomes that field's answer value.
      const nextValues: AnswerMap = { ...values };
      for (const field of schema.fields) {
        if (!isFileField(field)) continue;
        const file = pendingFiles[field.key];
        if (!file) continue;
        const form = new FormData();
        form.append("form_field_key", field.key);
        form.append("file", file);
        const res = await apiPostForm<UploadResponse>(
          `/registrations/${registrationId}/files`,
          form,
        );
        nextValues[field.key] = res.id;
      }

      // 3) Re-validate the merged map (now with real file ids) and persist. Backend re-validates too.
      const result = validateAnswers(schema, nextValues);
      if (!result.ok) {
        setFieldErrors(result.errors);
        toast.error("กรุณาแก้ไขช่องที่ถูกไฮไลต์");
        return;
      }
      await apiPatch(`/registrations/${registrationId}/answers`, { answers: result.values });
      toast.success("อัปเดตคำตอบแล้ว");
      router.push(`/me/registrations/${registrationId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถบันทึกคำตอบได้");
    } finally {
      setSaving(false); // single reset point — robust to early returns and thrown errors
    }
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link href={`/me/registrations/${registrationId}`}>
        <ArrowLeft className="size-4" />
        ย้อนกลับ
      </Link>
    </Button>
  );

  // Editing not allowed (status/window) — explain the SPECIFIC reason instead of a generic message.
  if (!canOfferEdit(detail)) {
    const reason = editDisallowedReason(detail) ?? "ไม่สามารถแก้ไขการลงทะเบียนนี้ได้";
    return (
      <div className="space-y-4">
        {back}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {reason}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Backend did not send the form schema with the detail → cannot render fields safely.
  if (!schema) {
    return (
      <div className="space-y-4">
        {back}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            แบบฟอร์มของการลงทะเบียนนี้ยังไม่พร้อมสำหรับการแก้ไขในขณะนี้
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {back}
      <h1 className="text-xl font-semibold">แก้ไขคำตอบ</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">แบบฟอร์มการลงทะเบียน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {fields.map((field) =>
            isFileField(field) ? (
              <FileField
                key={field.key}
                field={field}
                currentFileId={typeof values[field.key] === "string" ? (values[field.key] as string) : null}
                pendingFile={pendingFiles[field.key] ?? null}
                error={fieldErrors[field.key]}
                onPick={pickFile}
              />
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
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button asChild variant="outline" disabled={saving}>
          <Link href={`/me/registrations/${registrationId}`}>ยกเลิก</Link>
        </Button>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "กำลังบันทึก..." : "บันทึกการเปลี่ยนแปลง"}
        </Button>
      </div>

      {/* Confirm before replacing an already-uploaded file (the old one is overwritten on save). */}
      <ConfirmDialog
        open={replaceConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setReplaceConfirm(null);
        }}
        title="แทนที่ไฟล์เดิม?"
        description={
          replaceConfirm
            ? `คุณกำลังจะแทนที่ไฟล์ที่อัปโหลดไว้ด้วย "${replaceConfirm.file.name}" ไฟล์เดิมจะถูกแทนที่เมื่อคุณบันทึก`
            : undefined
        }
        confirmLabel="ใช้ไฟล์ใหม่"
        onConfirm={() => {
          if (replaceConfirm) {
            setPendingFiles((prev) => ({ ...prev, [replaceConfirm.key]: replaceConfirm.file }));
            setReplaceConfirm(null);
          }
        }}
      />
    </div>
  );
}

export default function EditAnswersPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
}) {
  const { registrationId } = use(params);
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <EditInner registrationId={registrationId} />
      </AppShell>
    </RequireRole>
  );
}
