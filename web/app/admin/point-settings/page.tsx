"use client";

// Admin > Point settings (plan §5/§7/§14). Edits the singleton point_settings: cutoff freeze,
// global default point values, scan-out fallback, peer config, staff self-reverse window.
// Cutoff is reward-deciding → its change goes through a reason-gated confirm dialog.
// Renders inside the admin layout (RequireRole + AppShell provided there).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getPointSettings, updatePointSettings } from "@/lib/points-api";
import type { PointSettings, PointSettingsPatch } from "@/lib/points-types";
import { isoToBangkokInput, bangkokInputToIso } from "@/components/admin-events/datetime";
import { formatBangkok } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { ReasonDialog } from "@/components/admin-tools/reason-dialog";

// Numeric field helper: keeps the input as a string so partial edits don't snap; parses on save.
function numField(v: number): string {
  return String(v);
}

export default function PointSettingsPage() {
  const [settings, setSettings] = useState<PointSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cutoffDialog, setCutoffDialog] = useState(false);

  // Editable mirror (strings for number/datetime inputs).
  const [form, setForm] = useState({
    cutoffAt: "", // Bangkok wall-clock for datetime-local
    defaultCheckinInPoints: "",
    defaultCheckinOutPoints: "",
    defaultAssessmentPoints: "",
    scanOutFallbackHours: "",
    peerEnabled: true,
    peerPoints: "",
    peerCooldownSec: "",
    staffReverseWindowMin: "",
    studentPointsVisible: true,
  });

  const hydrate = useCallback((s: PointSettings) => {
    setSettings(s);
    setForm({
      cutoffAt: isoToBangkokInput(s.cutoffAt),
      defaultCheckinInPoints: numField(s.defaultCheckinInPoints),
      defaultCheckinOutPoints: numField(s.defaultCheckinOutPoints),
      defaultAssessmentPoints: numField(s.defaultAssessmentPoints),
      scanOutFallbackHours: numField(s.scanOutFallbackHours),
      peerEnabled: s.peerEnabled,
      peerPoints: numField(s.peerPoints),
      peerCooldownSec: numField(s.peerCooldownSec),
      staffReverseWindowMin: numField(s.staffReverseWindowMin),
      studentPointsVisible: s.studentPointsVisible,
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getPointSettings();
      hydrate(res.settings);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ไม่สามารถโหลดการตั้งค่าได้");
    }
  }, [hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Build a patch of everything EXCEPT cutoff (cutoff saves via the reason dialog separately).
  function buildValuePatch(): PointSettingsPatch {
    return {
      default_checkin_in_points: Number(form.defaultCheckinInPoints),
      default_checkin_out_points: Number(form.defaultCheckinOutPoints),
      default_assessment_points: Number(form.defaultAssessmentPoints),
      scan_out_fallback_hours: Number(form.scanOutFallbackHours),
      peer_enabled: form.peerEnabled,
      peer_points: Number(form.peerPoints),
      peer_cooldown_sec: Number(form.peerCooldownSec),
      staff_reverse_window_min: Number(form.staffReverseWindowMin),
      student_points_visible: form.studentPointsVisible,
    };
  }

  // Student-points visibility toggle saves immediately (quick on/off before/after the activity).
  async function saveVisibility(next: boolean) {
    setField("studentPointsVisible", next);
    setSaving(true);
    try {
      const res = await updatePointSettings({ student_points_visible: next });
      hydrate(res.settings);
      toast.success(next ? "เปิดให้นักศึกษาเห็นระบบแต้มแล้ว" : "ซ่อนระบบแต้มจากนักศึกษาแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
      void load(); // revert optimistic toggle on failure
    } finally {
      setSaving(false);
    }
  }

  async function saveValues() {
    setSaving(true);
    try {
      const res = await updatePointSettings(buildValuePatch());
      hydrate(res.settings);
      toast.success("บันทึกค่าแต้มเริ่มต้นแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  // Cutoff change is sensitive (freezes the leaderboard / decides rewards) → reason required.
  async function saveCutoff(reason: string) {
    setSaving(true);
    try {
      const res = await updatePointSettings({
        cutoff_at: form.cutoffAt ? bangkokInputToIso(form.cutoffAt) : null,
        reason,
      });
      hydrate(res.settings);
      setCutoffDialog(false);
      toast.success(res.settings.cutoffAt ? "ตั้งเวลาตัดยอดแล้ว" : "ยกเลิกการตัดยอดแล้ว");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const frozen = settings.cutoffAt != null && new Date(settings.cutoffAt) <= new Date();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">ตั้งค่าแต้ม</h1>
        <p className="text-sm text-muted-foreground">
          ค่าเริ่มต้นทั้งระบบ ใช้กับทุกกิจกรรมที่ไม่ได้ตั้งค่าเฉพาะ (override)
        </p>
      </div>

      {/* Student-facing visibility — hide the points/peer/leaderboard tabs from students
          before the activity launches (earning still accrues in the background). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">การมองเห็นของนักศึกษา</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">แสดงระบบแต้มให้นักศึกษา</p>
              <p className="text-xs text-muted-foreground">
                ปิดไว้เพื่อซ่อนแท็บ แต้ม / เพิ่มเพื่อน / อันดับ จากนักศึกษา (กันสปอยล์ก่อนเริ่มกิจกรรม) —
                แต้มยังสะสมเบื้องหลังตามปกติ, สตาฟ/แอดมินไม่ได้รับผลกระทบ
              </p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.studentPointsVisible}
                disabled={saving}
                onChange={(e) => void saveVisibility(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              {form.studentPointsVisible ? "แสดงอยู่" : "ซ่อนอยู่"}
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Cutoff freeze — the reward-deciding switch. Kept separate + reason-gated. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">เวลาตัดยอด (Cutoff)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            หลังเวลานี้ ระบบจะหยุดรับแต้มจากนักศึกษาทั้งหมด (อันดับจะนิ่ง = ผลตัดสิน) —
            ผู้ดูแลยังแก้/ถอนรายการได้
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cutoff">เวลาตัดยอด (เวลาไทย)</Label>
              <Input
                id="cutoff"
                type="datetime-local"
                value={form.cutoffAt}
                onChange={(e) => setField("cutoffAt", e.target.value)}
                className="w-64"
              />
            </div>
            <Button variant="outline" onClick={() => setField("cutoffAt", "")} disabled={!form.cutoffAt}>
              ล้าง (ไม่ตัดยอด)
            </Button>
            <Button onClick={() => setCutoffDialog(true)} disabled={saving}>
              บันทึกเวลาตัดยอด
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            ปัจจุบัน:{" "}
            {settings.cutoffAt ? (
              <span className={frozen ? "font-medium text-red-600" : "font-medium text-foreground"}>
                {formatBangkok(settings.cutoffAt)} {frozen ? "(ตัดยอดแล้ว)" : "(ตั้งไว้)"}
              </span>
            ) : (
              "ยังไม่ตั้งเวลาตัดยอด"
            )}
          </p>
        </CardContent>
      </Card>

      {/* Global default point values + peer/reverse config (saved together, no reason). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ค่าแต้มเริ่มต้น</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField
              label="เช็คอินเข้า (แต้ม)"
              value={form.defaultCheckinInPoints}
              onChange={(v) => setField("defaultCheckinInPoints", v)}
            />
            <NumberField
              label="เช็คอินออก (แต้ม)"
              value={form.defaultCheckinOutPoints}
              onChange={(v) => setField("defaultCheckinOutPoints", v)}
            />
            <NumberField
              label="แบบประเมิน (แต้ม)"
              value={form.defaultAssessmentPoints}
              onChange={(v) => setField("defaultAssessmentPoints", v)}
            />
            <NumberField
              label="ช่วงสแกนออก fallback (ชั่วโมง)"
              value={form.scanOutFallbackHours}
              onChange={(v) => setField("scanOutFallbackHours", v)}
              help="เปิดสแกนออกหลังจบงานกี่ชั่วโมง (เมื่อไม่ได้ตั้งช่วงเอง)"
            />
          </div>

          <div className="rounded-md border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="font-medium">เพิ่มเพื่อน (Peer)</p>
                <p className="text-xs text-muted-foreground">เปิด/ปิดการแจกแต้มเพิ่มเพื่อนทั้งระบบ</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.peerEnabled}
                  onChange={(e) => setField("peerEnabled", e.target.checked)}
                  className="size-4 rounded border-input accent-primary"
                />
                เปิดใช้งาน
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label="แต้มต่อการเพิ่มเพื่อน"
                value={form.peerPoints}
                onChange={(v) => setField("peerPoints", v)}
              />
              <NumberField
                label="คูลดาวน์ก่อนสแกนคนต่อไป (วินาที)"
                value={form.peerCooldownSec}
                onChange={(v) => setField("peerCooldownSec", v)}
                help="0 = ปิดคูลดาวน์"
              />
            </div>
          </div>

          <NumberField
            label="ช่วงเวลาให้สตาฟถอนแต้มที่แจกเองได้ (นาที)"
            value={form.staffReverseWindowMin}
            onChange={(v) => setField("staffReverseWindowMin", v)}
            help="0 = ปิดความสามารถนี้ (ให้ผู้ดูแลถอนแทน)"
          />

          <div className="flex items-center justify-end gap-2">
            {saving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            <Button onClick={saveValues} disabled={saving}>
              บันทึกค่าเริ่มต้น
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            อัปเดตล่าสุด {formatBangkok(settings.updatedAt)}
          </p>
        </CardContent>
      </Card>

      <ReasonDialog
        open={cutoffDialog}
        onOpenChange={setCutoffDialog}
        title={form.cutoffAt ? "ยืนยันเวลาตัดยอด" : "ยกเลิกการตัดยอด"}
        description={
          form.cutoffAt
            ? "หลังเวลานี้ ระบบจะหยุดรับแต้มจากนักศึกษาทั้งหมด — เป็นเวลาที่ใช้ตัดสินรางวัล"
            : "ยกเลิกการตัดยอด ระบบจะรับแต้มต่อ"
        }
        confirmLabel="ยืนยัน"
        destructive
        pending={saving}
        onConfirm={saveCutoff}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
