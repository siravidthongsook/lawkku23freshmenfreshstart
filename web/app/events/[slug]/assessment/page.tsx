"use client";

// /events/[slug]/assessment — student fills the event's active assessment form (the 2nd form, plan §4.3).
// Resolves the event by slug (→ uuid), loads the active assessment + this student's submission status,
// renders the fields (reusing FormFieldInput), and submits to POST /events/:id/assessment for +100 once.
// One submission per event: after success (or already_submitted) the form locks to a "ทำแล้ว ✓" state.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { EventPublic } from "@/lib/types";
import { getAssessment, submitAssessment } from "@/lib/points-api";
import type { AssessmentGetResponse } from "@/lib/points-types";
import { isFileField, validateAnswers, type AnswerMap, type FormSchema } from "@/lib/schemas";
import { pointResultLabel } from "@/lib/labels";
import { RequireRole } from "@/components/guards";
import { AppShell } from "@/components/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { FormFieldInput } from "@/components/student/form-fields";
import { toast } from "sonner";

type Loaded = { event: EventPublic; assessment: AssessmentGetResponse };

function AssessmentInner({ slug }: { slug: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [values, setValues] = useState<AnswerMap>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ submitted: boolean; pointsAwarded?: number }>({ submitted: false });

  useEffect(() => {
    let active = true;
    setError(null);
    setData(null);
    (async () => {
      // slug → event (need the uuid for the assessment endpoints).
      const { event } = await apiGet<{ event: EventPublic }>(`/events/${slug}`);
      const assessment = await getAssessment(event.id);
      if (active) {
        setData({ event, assessment });
        setDone({ submitted: assessment.submitted });
      }
    })().catch((e) => {
      if (active) setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดแบบประเมินได้");
    });
    return () => {
      active = false;
    };
  }, [slug, reloadKey]);

  const schema = data?.assessment.form?.schema as FormSchema | undefined;
  const fields = useMemo(
    () => (schema ? [...schema.fields].sort((a, b) => a.sort - b.sort) : []),
    [schema],
  );

  const submit = useCallback(async () => {
    if (!data || !schema) return;
    setFieldErrors({});
    const result = validateAnswers(schema, values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitAssessment(data.event.id, result.values);
      if (res.result === "submitted_success") {
        toast.success(`ส่งแบบประเมินสำเร็จ +${res.pointsAwarded ?? 0} แต้ม`);
        setDone({ submitted: true, pointsAwarded: res.pointsAwarded });
      } else if (res.result === "already_submitted") {
        toast.message(pointResultLabel(res.result));
        setDone({ submitted: true });
      } else {
        // not-open / closed / checkin-required / points-closed / no-form → surface the reason.
        toast.error(pointResultLabel(res.result));
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "ส่งแบบประเมินไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  }, [data, schema, values]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/events/${slug}`}>
          <ArrowLeft className="size-4" /> กลับไปหน้ากิจกรรม
        </Link>
      </Button>

      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : data === null ? (
        <Skeleton className="h-64 w-full" />
      ) : !data.assessment.enabled || !data.assessment.form ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            กิจกรรมนี้ยังไม่มีแบบประเมิน
          </CardContent>
        </Card>
      ) : done.submitted ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CheckCircle2 className="size-10 text-green-600" />
            <p className="font-medium">ทำแบบประเมินแล้ว</p>
            <p className="text-sm text-muted-foreground">
              คุณได้ส่งแบบประเมินของกิจกรรม {data.event.title} เรียบร้อยแล้ว
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">แบบประเมิน — {data.event.title}</CardTitle>
            {/* +100 banner, clear before submit (plan §14). */}
            <p className="rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
              ทำแบบประเมินครั้งเดียวเพื่อรับแต้ม (ทำได้ครั้งเดียวต่อกิจกรรม)
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {fields.map((field) =>
              isFileField(field) ? (
                <div key={field.key} className="space-y-1">
                  <p className="text-sm font-medium">{field.label}</p>
                  <p className="text-xs text-muted-foreground">
                    แบบประเมินไม่รองรับการแนบไฟล์
                  </p>
                </div>
              ) : (
                <FormFieldInput
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  error={fieldErrors[field.key]}
                  onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
                />
              ),
            )}
            <Button className="w-full" disabled={submitting} onClick={() => void submit()}>
              {submitting ? "กำลังส่ง…" : "ส่งแบบประเมิน"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AssessmentPage() {
  const params = useParams<{ slug: string }>();
  return (
    <RequireRole roles={["student"]}>
      <AppShell>
        <AssessmentInner slug={params.slug} />
      </AppShell>
    </RequireRole>
  );
}
