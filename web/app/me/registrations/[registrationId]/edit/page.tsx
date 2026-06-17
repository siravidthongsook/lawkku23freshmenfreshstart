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
import { extractFormSchema, canOfferEdit } from "@/components/student/detail-helpers";
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

  useEffect(() => {
    let active = true;
    apiGet<RegistrationDetailResponse>(`/me/registrations/${registrationId}`)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setSchema(extractFormSchema(d));
        setValues({ ...(d.answers ?? {}) }); // seed with current answers
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

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }
  function pickFile(key: string, file: File | null) {
    setPendingFiles((prev) => ({ ...prev, [key]: file }));
  }

  async function handleSave() {
    if (!schema) return;
    setSaving(true);
    setFieldErrors({});
    try {
      // 1) Upload newly-picked files first; the returned file id becomes that field's answer value.
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

      // 2) Validate the merged answer map against the registration's own schema.
      const result = validateAnswers(schema, nextValues);
      if (!result.ok) {
        setFieldErrors(result.errors);
        toast.error("กรุณาแก้ไขช่องที่ถูกไฮไลต์");
        setSaving(false);
        return;
      }

      // 3) Persist answers (JSON). Backend re-validates + enforces edit window/status.
      await apiPatch(`/registrations/${registrationId}/answers`, { answers: result.values });
      toast.success("อัปเดตคำตอบแล้ว");
      router.push(`/me/registrations/${registrationId}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ไม่สามารถบันทึกคำตอบได้");
      setSaving(false);
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

  // Editing not allowed (status/window) — explain instead of rendering a form that will be rejected.
  if (!canOfferEdit(detail)) {
    return (
      <div className="space-y-4">
        {back}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ไม่สามารถแก้ไขการลงทะเบียนนี้ได้
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
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกการเปลี่ยนแปลง"}
        </Button>
      </div>
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
