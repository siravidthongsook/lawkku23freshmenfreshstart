"use client";

// Admin > per-event point config (plan §4.x/§7/§14). Toggles (check-in in/out, assessment +
// requires-checkin) and nullable point overrides (blank = use global default). Mid-event changes
// are forward-only — we warn about that. Lazy-creates the config row.
// NOTE: scan/assessment time windows moved to the event-edit page (timing lives with the event).
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getEventPointConfig, updateEventPointConfig } from "@/lib/points-api";
import type { EventPointConfig, EventPointConfigPatch } from "@/lib/points-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";

// Toggle row helper.
function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border p-3">
      <span>
        <span className="font-medium">{label}</span>
        {help ? <span className="block text-xs text-muted-foreground">{help}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-input accent-primary"
      />
    </label>
  );
}

export default function EventPointConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [config, setConfig] = useState<EventPointConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form mirror. Point overrides are strings ("" = use default). Windows are Bangkok wall-clock.
  const [form, setForm] = useState({
    checkinInEnabled: true,
    checkinOutEnabled: true,
    assessmentEnabled: false,
    assessmentRequiresCheckin: true,
    checkinInPoints: "",
    checkinOutPoints: "",
    assessmentPoints: "",
  });

  const hydrate = useCallback((c: EventPointConfig | null) => {
    setConfig(c);
    // null config = no override row yet → fall back to documented defaults (in+out=on, assess=off).
    setForm({
      checkinInEnabled: c?.checkinInEnabled ?? true,
      checkinOutEnabled: c?.checkinOutEnabled ?? true,
      assessmentEnabled: c?.assessmentEnabled ?? false,
      assessmentRequiresCheckin: c?.assessmentRequiresCheckin ?? true,
      checkinInPoints: c?.checkinInPoints != null ? String(c.checkinInPoints) : "",
      checkinOutPoints: c?.checkinOutPoints != null ? String(c.checkinOutPoints) : "",
      assessmentPoints: c?.assessmentPoints != null ? String(c.assessmentPoints) : "",
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getEventPointConfig(id);
      hydrate(res.config);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการตั้งค่าได้");
    }
  }, [id, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Empty point override → null (use global default).
  function numOrNull(v: string): number | null {
    return v.trim() === "" ? null : Number(v);
  }

  async function save() {
    setSaving(true);
    try {
      const patch: EventPointConfigPatch = {
        checkin_in_enabled: form.checkinInEnabled,
        checkin_out_enabled: form.checkinOutEnabled,
        assessment_enabled: form.assessmentEnabled,
        assessment_requires_checkin: form.assessmentRequiresCheckin,
        checkin_in_points: numOrNull(form.checkinInPoints),
        checkin_out_points: numOrNull(form.checkinOutPoints),
        assessment_points: numOrNull(form.assessmentPoints),
        // Scan/assessment windows now edited on the event-edit page (eventPointConfig timing).
      };
      const res = await updateEventPointConfig(id, patch);
      hydrate(res.config);
      toast.success("บันทึกการตั้งค่าแต้มแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!loaded) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/events/${id}`}>
            <ArrowLeft className="size-4" /> ย้อนกลับ
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">ตั้งค่าแต้มของกิจกรรม</h1>
      </div>

      {/* Forward-only warning (plan §10/§14). */}
      <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        การเปลี่ยนค่าแต้มระหว่างกิจกรรมมีผลเฉพาะรายการใหม่ (forward-only) ไม่ย้อนหลังแต้มที่แจกไปแล้ว
      </p>

      {/* Toggles */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">เปิด/ปิดการเก็บแต้ม</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Toggle
            label="สแกนเข้า"
            checked={form.checkinInEnabled}
            onChange={(v) => setField("checkinInEnabled", v)}
          />
          <Toggle
            label="สแกนออก"
            checked={form.checkinOutEnabled}
            onChange={(v) => setField("checkinOutEnabled", v)}
          />
          <Toggle
            label="แบบประเมิน"
            checked={form.assessmentEnabled}
            onChange={(v) => setField("assessmentEnabled", v)}
          />
          <Toggle
            label="ต้องสแกนเข้าก่อนทำแบบประเมิน"
            help="กันการฟาร์มแต้มข้ามงาน"
            checked={form.assessmentRequiresCheckin}
            onChange={(v) => setField("assessmentRequiresCheckin", v)}
          />
        </CardContent>
      </Card>

      {/* Point overrides */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ค่าแต้มเฉพาะกิจกรรม</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">เว้นว่าง = ใช้ค่าเริ่มต้นทั้งระบบ</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <OverrideField
              label="เช็คอินเข้า"
              value={form.checkinInPoints}
              onChange={(v) => setField("checkinInPoints", v)}
            />
            <OverrideField
              label="เช็คอินออก"
              value={form.checkinOutPoints}
              onChange={(v) => setField("checkinOutPoints", v)}
            />
            <OverrideField
              label="แบบประเมิน"
              value={form.assessmentPoints}
              onChange={(v) => setField("assessmentPoints", v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Windows moved to the event-edit page (timing lives with the event). Point this out. */}
      <p className="text-sm text-muted-foreground">
        ช่วงเวลาสแกน/แบบประเมินย้ายไปตั้งที่{" "}
        <Link href={`/admin/events/${id}/edit`} className="font-medium text-primary underline">
          หน้าแก้ไขกิจกรรม
        </Link>
      </p>

      <div className="flex items-center justify-between">
        <Button asChild variant="outline">
          <Link href={`/admin/events/${id}/assessment`}>แก้แบบประเมิน →</Link>
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "กำลังบันทึก…" : "บันทึก"}
        </Button>
      </div>
      {config == null ? (
        <p className="text-xs text-muted-foreground">ยังไม่ได้ตั้งค่าเฉพาะกิจกรรมนี้ (ใช้ค่าเริ่มต้นทั้งหมด)</p>
      ) : null}
    </div>
  );
}

function OverrideField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ค่าเริ่มต้น"
      />
    </div>
  );
}

