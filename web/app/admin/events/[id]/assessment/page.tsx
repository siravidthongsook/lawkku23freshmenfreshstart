"use client";

// Admin > assessment form builder (plan §4.3). Second form per event (separate from registration),
// reuses the same FormBuilder UI but saves via the assessment PUT endpoint (formType="assessment").
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getAssessmentForm, putAssessmentForm } from "@/lib/points-api";
import type { FormField, FormSchema } from "@/lib/schemas";
import { FormBuilder, type SavedForm } from "@/components/admin-events/form-builder";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";

// The assessment GET/PUT return a form-version row; normalize to the builder's SavedForm shape.
type AssessmentRow = { id: string; versionNumber: number; schemaJson: FormSchema; isActive?: boolean };

export default function AssessmentBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  // undefined = loading; null = none built yet (start empty).
  const [form, setForm] = useState<AssessmentRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getAssessmentForm(id);
      setForm((res.form as AssessmentRow | null) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดแบบประเมินได้");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const initialFields: FormField[] = form?.schemaJson?.fields ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {/* Reachable from both the points page and the event toolbar — go back to wherever we came from,
            falling back to the event overview when there's no in-app history (direct URL / fresh tab). */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            window.history.length > 1 ? router.back() : router.push(`/admin/events/${id}`)
          }
        >
          <ArrowLeft className="size-4" /> ย้อนกลับ
        </Button>
        <h1 className="text-xl font-semibold">แบบประเมิน (form ที่ 2)</h1>
      </div>

      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        แบบประเมินแยกจากฟอร์มลงทะเบียน นักศึกษาทำได้ 1 ครั้ง/งาน และจะได้แต้มตามที่ตั้งไว้ในหน้าตั้งค่าแต้ม
      </p>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : form === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <FormBuilder
          key={reloadKey}
          eventId={id}
          initialFields={initialFields}
          versionNumber={form?.versionNumber ?? null}
          // Assessment saves through a single PUT (in-place edit or fork when answers exist).
          saveSchema={async (schema) => {
            const res = await putAssessmentForm(id, schema);
            const saved = res.form as AssessmentRow;
            return {
              form: { ...saved, isActive: saved.isActive ?? true } as SavedForm,
              versioned: res.versioned,
            };
          }}
          onSaved={(saved) => {
            setForm(saved as AssessmentRow);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
