"use client";

// Google-Forms-style form builder. Edits a FormSchema (fields[]). Used by /admin/events/[id]/form.
// Label/help/sort = safe edit. Structural change (type/required/options/key add-remove) → forces a new
// version once submissions exist; we surface that with a warning and a "Save as new version" action.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { FIELD_TYPES, formSchema, type FormField, type FormSchema } from "@/lib/schemas";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReasonDialog } from "./reason-dialog";

// Field types that carry an options list.
const CHOICE_TYPES = new Set<FormField["type"]>([
  "single_choice",
  "multiple_choice",
  "dropdown",
]);

const TYPE_LABEL: Record<string, string> = {
  short_text: "ข้อความสั้น",
  paragraph: "ย่อหน้า",
  number: "ตัวเลข",
  single_choice: "เลือกได้หนึ่งข้อ",
  multiple_choice: "เลือกได้หลายข้อ",
  dropdown: "เมนูแบบเลื่อนลง",
  checkbox: "ช่องทำเครื่องหมาย",
  date: "วันที่",
  time: "เวลา",
  file_upload: "อัปโหลดไฟล์",
};

// Shape of a saved form version returned by PATCH/POST (subset we rely on; schemaJson re-baselines the builder).
export type SavedForm = {
  id: string;
  versionNumber: number;
  schemaJson: FormSchema;
  isActive: boolean;
};

type Props = {
  eventId: string;
  initialFields: FormField[];
  // Original schema = baseline to detect structural changes against (the active version's schema).
  versionNumber: number | null;
  // Pass the just-saved form row up so the page can set state directly (never refetch-to-empty).
  onSaved: (form: SavedForm) => void;
  // Assessment mode: single PUT save (no separate "new version" button). When provided this REPLACES
  // the registration-form PATCH/POST endpoints, so the same builder UI drives the assessment form too.
  saveSchema?: (schema: FormSchema) => Promise<{ form: SavedForm; versioned?: boolean }>;
};

// Detect structural diff (mirrors backend isStructuralChange): add/remove key, or type/required/options change.
function isStructural(oldFields: FormField[], newFields: FormField[]): boolean {
  const oldByKey = new Map(oldFields.map((f) => [f.key, f]));
  const newByKey = new Map(newFields.map((f) => [f.key, f]));
  if (oldByKey.size !== newByKey.size) return true;
  for (const k of oldByKey.keys()) if (!newByKey.has(k)) return true;
  for (const k of newByKey.keys()) if (!oldByKey.has(k)) return true;
  for (const [k, oldF] of oldByKey) {
    const newF = newByKey.get(k)!;
    if (oldF.type !== newF.type) return true;
    if (oldF.required !== newF.required) return true;
    const ao = oldF.options ?? [];
    const bo = newF.options ?? [];
    if (ao.length !== bo.length || ao.some((v, i) => v !== bo[i])) return true;
  }
  return false;
}

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `field_${Date.now().toString(36)}_${keyCounter}`;
}

export function FormBuilder({ eventId, initialFields, versionNumber, onSaved, saveSchema }: Props) {
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [saving, setSaving] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  // Field keys flagged invalid by the last save attempt → highlight their cards.
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set());
  // Field index pending delete confirmation (null = no dialog open).
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const structural = useMemo(
    () => isStructural(initialFields, fields),
    [initialFields, fields],
  );

  // Dirty = any difference from the loaded baseline. Drives the unsaved-changes guard.
  // Cheap deep-equality via JSON (field count is small for this internal system).
  const dirty = useMemo(
    () => JSON.stringify(fields) !== JSON.stringify(initialFields),
    [fields, initialFields],
  );
  useUnsavedChanges(dirty);

  function update(idx: number, patch: Partial<FormField>) {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }

  function addField() {
    setFields((prev) => [
      ...prev,
      {
        key: freshKey(),
        type: "short_text",
        label: "คำถามไม่มีชื่อ",
        required: false,
        sort: prev.length,
      },
    ]);
  }

  function removeField(idx: number) {
    setFields((prev) => prev.filter((_, i) => i !== idx).map((f, i) => ({ ...f, sort: i })));
  }

  function move(idx: number, dir: -1 | 1) {
    setFields((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((f, i) => ({ ...f, sort: i })); // resync sort to position
    });
  }

  // Build + validate the schema payload before any save.
  // Normalizes option lists here (trim + drop blank lines) so live typing isn't fought (see :341).
  function buildSchema(): FormSchema | null {
    const normalized = fields.map((f, i) => ({
      ...f,
      sort: i,
      options: f.options
        ? f.options.map((o) => o.trim()).filter((o) => o !== "")
        : f.options,
    }));
    const candidate: FormSchema = { fields: normalized };
    const parsed = formSchema.safeParse(candidate);
    if (!parsed.success) {
      // Map issues back to their field key so we can highlight the offending cards.
      const bad = new Set<string>();
      for (const issue of parsed.error.issues) {
        const idx = issue.path[1]; // path = ["fields", index, ...]
        if (typeof idx === "number" && normalized[idx]) bad.add(normalized[idx].key);
      }
      setInvalidKeys(bad);
      toast.error(parsed.error.issues[0]?.message ?? "ฟอร์มมีฟิลด์ที่ไม่ถูกต้อง");
      return null;
    }
    // Choice fields must carry at least one (non-blank) option.
    const bad = new Set<string>();
    for (const f of parsed.data.fields) {
      if (CHOICE_TYPES.has(f.type) && (!f.options || f.options.length === 0)) bad.add(f.key);
    }
    if (bad.size > 0) {
      setInvalidKeys(bad);
      const first = parsed.data.fields.find((f) => bad.has(f.key));
      toast.error(`"${first?.label}" ต้องมีตัวเลือกอย่างน้อยหนึ่งข้อ`);
      return null;
    }
    setInvalidKeys(new Set()); // valid → clear highlights
    return parsed.data;
  }

  // Safe save: PATCH (registration) or the injected saveSchema (assessment PUT). Backend decides
  // in-place vs auto-version when submissions exist.
  async function handleSave() {
    const schema = buildSchema();
    if (!schema || saving) return;
    setSaving(true);
    try {
      // PATCH returns the resulting form row + whether it forked a version. Hand the row up to re-baseline.
      const res = saveSchema
        ? await saveSchema(schema)
        : await apiPatch<{ form: SavedForm; versioned: boolean }>(
            `/admin/events/${eventId}/form`,
            { schema },
          );
      toast.success(res.versioned ? "บันทึกเป็นฟอร์มเวอร์ชันใหม่แล้ว" : "บันทึกฟอร์มแล้ว");
      onSaved(res.form);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถบันทึกฟอร์มได้");
    } finally {
      setSaving(false);
    }
  }

  // Explicit new version (reason recorded). POST /form/version.
  async function handleNewVersion(reason: string) {
    const schema = buildSchema();
    if (!schema) return;
    try {
      // POST returns the new active form row; hand it up so the page re-baselines without a refetch.
      const res = await apiPost<{ form: SavedForm }>(
        `/admin/events/${eventId}/form/version`,
        { schema, reason },
      );
      toast.success("สร้างฟอร์มเวอร์ชันใหม่แล้ว");
      onSaved(res.form);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "ไม่สามารถสร้างเวอร์ชันได้");
      throw err; // keep dialog open on failure
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {versionNumber != null ? (
            // Badge marks which form version is live; existing registrations stay on it until forked.
            <Badge variant="outline" title="เวอร์ชันที่ใช้งานอยู่" aria-label="เวอร์ชันที่ใช้งานอยู่">
              เวอร์ชัน {versionNumber}
            </Badge>
          ) : null}
          <span>{fields.length} ฟิลด์</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={addField}>
            <Plus className="size-4" />
            เพิ่มฟิลด์
          </Button>
          {/* Primary action. New-version is demoted to a low-emphasis link so the two aren't confused. */}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "กำลังบันทึก…" : "บันทึก"}
          </Button>
          {/* Explicit new-version is a registration-form action only; assessment saves via a single PUT. */}
          {!saveSchema ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setReasonOpen(true)}
            >
              บันทึกเป็นเวอร์ชันใหม่…
            </Button>
          ) : null}
        </div>
      </div>

      {/* Static explainer: clarifies what each save button does so admins know when a new version is created. */}
      <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ul className="space-y-1">
          <li>
            <span className="font-medium text-foreground">บันทึก</span> = แก้ไขในเวอร์ชันเดิม (ถ้ายังไม่มีการลงทะเบียน
            หรือแก้เฉพาะป้ายกำกับ/ลำดับ); ถ้าเปลี่ยนโครงสร้างและมีการลงทะเบียนแล้ว ระบบจะสร้างเวอร์ชันใหม่ให้อัตโนมัติ
          </li>
          <li>
            <span className="font-medium text-foreground">บันทึกเป็นเวอร์ชันใหม่</span> = แยกเวอร์ชันใหม่ทันที
            พร้อมบันทึกเหตุผล การลงทะเบียนเดิมยังใช้เวอร์ชันเก่า
          </li>
        </ul>
      </div>

      {/* Structural-change warning: existing submissions keep their old version; saving may fork a version. */}
      {structural ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ตรวจพบการเปลี่ยนแปลงเชิงโครงสร้าง (เพิ่ม/ลบฟิลด์ หรือเปลี่ยนประเภท/ความจำเป็น/ตัวเลือก) หาก
          กิจกรรมนี้มีการส่งแบบฟอร์มอยู่แล้ว การบันทึกจะสร้างฟอร์มเวอร์ชันใหม่เพื่อให้การลงทะเบียน
          ที่มีอยู่ยังคงใช้ฟอร์มเดิม
        </div>
      ) : null}

      {fields.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          ยังไม่มีฟิลด์ เพิ่มคำถามแรกของคุณ
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f, idx) => (
            <FieldEditor
              key={f.key}
              field={f}
              index={idx}
              total={fields.length}
              invalid={invalidKeys.has(f.key)}
              onChange={(patch) => update(idx, patch)}
              onRemove={() => setPendingDelete(idx)}
              onMove={(dir) => move(idx, dir)}
            />
          ))}
        </div>
      )}

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title="สร้างฟอร์มเวอร์ชันใหม่"
        description="บันทึกเหตุผลไว้ในบันทึกการตรวจสอบ การลงทะเบียนที่มีอยู่จะยังคงใช้เวอร์ชันปัจจุบัน"
        confirmLabel="สร้างเวอร์ชัน"
        onConfirm={handleNewVersion}
      />

      {/* Delete-field confirm — instant delete was easy to misfire. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="ลบฟิลด์นี้?"
        description={
          pendingDelete !== null
            ? `ฟิลด์ "${fields[pendingDelete]?.label ?? ""}" จะถูกลบออกจากฟอร์ม (ยังไม่บันทึกจนกว่าจะกดบันทึก)`
            : undefined
        }
        confirmLabel="ลบฟิลด์"
        variant="danger"
        onConfirm={() => {
          if (pendingDelete !== null) removeField(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function FieldEditor({
  field,
  index,
  total,
  invalid,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  index: number;
  total: number;
  invalid?: boolean;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const isChoice = CHOICE_TYPES.has(field.type);
  const optionsText = (field.options ?? []).join("\n");

  return (
    <Card className={cn(invalid && "border-destructive ring-1 ring-destructive")}>
      <CardContent className="space-y-3 pt-4">
        {/* Grip icon removed — no DnD wired (only the up/down arrows reorder), so it implied a gesture that doesn't work. */}
        <div className="flex items-start gap-2">
          <div className="grid flex-1 gap-3 sm:grid-cols-[1fr_200px]">
            <div className="space-y-1.5">
              <Label>ป้ายกำกับคำถาม</Label>
              <Input
                value={field.label}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder="คำถาม"
              />
            </div>
            <div className="space-y-1.5">
              <Label>ประเภท</Label>
              <Select
                value={field.type}
                onValueChange={(v) =>
                  // Switching away from a choice type drops options; into one initialises empty.
                  onChange({
                    type: v as FormField["type"],
                    options: CHOICE_TYPES.has(v as FormField["type"])
                      ? (field.options ?? [])
                      : undefined,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABEL[t] ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>ข้อความช่วยเหลือ (ไม่บังคับ)</Label>
          <Input
            value={field.help ?? ""}
            onChange={(e) => onChange({ help: e.target.value === "" ? undefined : e.target.value })}
            placeholder="แสดงใต้คำถาม"
          />
        </div>

        {isChoice ? (
          <div className="space-y-1.5">
            <Label>ตัวเลือก (หนึ่งบรรทัดต่อหนึ่งตัวเลือก)</Label>
            {/* Split only — don't trim/filter live (that fights typing). buildSchema normalizes on save. */}
            <Textarea
              value={optionsText}
              onChange={(e) => onChange({ options: e.target.value.split("\n") })}
              rows={3}
              placeholder={"ตัวเลือก 1\nตัวเลือก 2"}
            />
          </div>
        ) : null}

        <Separator />

        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => onChange({ required: e.target.checked })}
              className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            จำเป็น
          </label>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label="เลื่อนขึ้น"
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              aria-label="เลื่อนลง"
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              aria-label="ลบฟิลด์"
              className="text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
