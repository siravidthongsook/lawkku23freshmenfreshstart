"use client";

// Form Builder page. GET /admin/events/:id/form → { form } (or { form: null } when none built yet).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiGet, ApiError } from "@/lib/api";
import type { FormField } from "@/lib/schemas";
import { FormBuilder, type SavedForm } from "@/components/admin-events/form-builder";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Stored form version shape (forms service returns the row): schemaJson holds the FormSchema.
// Reuses SavedForm so GET and the save handlers agree on the row shape.
type FormVersion = SavedForm;

export default function FormBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [form, setForm] = useState<FormVersion | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);
  // Bump to remount the builder after a save so it re-baselines against the new active version.
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ form: FormVersion | null }>(`/admin/events/${id}/form`);
      setForm(res.form);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถโหลดฟอร์มได้");
      setForm(null);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const initialFields: FormField[] = form?.schemaJson?.fields ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/events/${id}`}>
            <ArrowLeft className="size-4" />
            ย้อนกลับ
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">เครื่องมือสร้างฟอร์ม</h1>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {form === undefined ? (
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
          onSaved={(saved) => {
            // Set state from the just-saved row (never refetch-to-empty, which would let a later PATCH wipe fields).
            setForm(saved);
            setReloadKey((k) => k + 1); // remount builder so initialFields re-baselines to the saved schema
          }}
        />
      )}
    </div>
  );
}
