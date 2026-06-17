"use client";

// Google-Forms-style form builder. Edits a FormSchema (fields[]). Used by /admin/events/[id]/form.
// Label/help/sort = safe edit. Structural change (type/required/options/key add-remove) → forces a new
// version once submissions exist; we surface that with a warning and a "Save as new version" action.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { FIELD_TYPES, formSchema, type FormField, type FormSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReasonDialog } from "./reason-dialog";

// Field types that carry an options list.
const CHOICE_TYPES = new Set<FormField["type"]>([
  "single_choice",
  "multiple_choice",
  "dropdown",
]);

const TYPE_LABEL: Record<string, string> = {
  short_text: "Short text",
  paragraph: "Paragraph",
  number: "Number",
  single_choice: "Single choice",
  multiple_choice: "Multiple choice",
  dropdown: "Dropdown",
  checkbox: "Checkbox",
  date: "Date",
  time: "Time",
  file_upload: "File upload",
};

type Props = {
  eventId: string;
  initialFields: FormField[];
  // Original schema = baseline to detect structural changes against (the active version's schema).
  versionNumber: number | null;
  onSaved: () => void;
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

export function FormBuilder({ eventId, initialFields, versionNumber, onSaved }: Props) {
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [saving, setSaving] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);

  const structural = useMemo(
    () => isStructural(initialFields, fields),
    [initialFields, fields],
  );

  function update(idx: number, patch: Partial<FormField>) {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }

  function addField() {
    setFields((prev) => [
      ...prev,
      {
        key: freshKey(),
        type: "short_text",
        label: "Untitled question",
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
  function buildSchema(): FormSchema | null {
    const candidate: FormSchema = { fields: fields.map((f, i) => ({ ...f, sort: i })) };
    const parsed = formSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Form has invalid fields.");
      return null;
    }
    // Choice fields must carry at least one option.
    for (const f of parsed.data.fields) {
      if (CHOICE_TYPES.has(f.type) && (!f.options || f.options.length === 0)) {
        toast.error(`"${f.label}" needs at least one option.`);
        return null;
      }
    }
    return parsed.data;
  }

  // Safe save: PATCH. Backend decides in-place vs auto-version when no submissions exist.
  async function handleSave() {
    const schema = buildSchema();
    if (!schema || saving) return;
    setSaving(true);
    try {
      const res = await apiPatch<{ versioned: boolean }>(
        `/admin/events/${eventId}/form`,
        { schema },
      );
      toast.success(res.versioned ? "Saved as a new form version." : "Form saved.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save form.");
    } finally {
      setSaving(false);
    }
  }

  // Explicit new version (reason recorded). POST /form/version.
  async function handleNewVersion(reason: string) {
    const schema = buildSchema();
    if (!schema) return;
    try {
      await apiPost(`/admin/events/${eventId}/form/version`, { schema, reason });
      toast.success("New form version created.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create version.");
      throw err; // keep dialog open on failure
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {versionNumber != null ? <Badge variant="outline">Version {versionNumber}</Badge> : null}
          <span>{fields.length} field(s)</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={addField}>
            <Plus className="size-4" />
            Add field
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={() => setReasonOpen(true)}>
            Save as new version
          </Button>
        </div>
      </div>

      {/* Structural-change warning: existing submissions keep their old version; saving may fork a version. */}
      {structural ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Structural change detected (field added/removed, or type/required/options changed). If this
          event already has submissions, saving will create a new form version so existing
          registrations keep their original form.
        </div>
      ) : null}

      {fields.length === 0 ? (
        <div className="rounded-md border py-16 text-center text-sm text-muted-foreground">
          No fields yet. Add your first question.
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f, idx) => (
            <FieldEditor
              key={f.key}
              field={f}
              index={idx}
              total={fields.length}
              onChange={(patch) => update(idx, patch)}
              onRemove={() => removeField(idx)}
              onMove={(dir) => move(idx, dir)}
            />
          ))}
        </div>
      )}

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title="Create new form version"
        description="Records a reason in the audit log. Existing registrations keep their current version."
        confirmLabel="Create version"
        onConfirm={handleNewVersion}
      />
    </div>
  );
}

function FieldEditor({
  field,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  index: number;
  total: number;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const isChoice = CHOICE_TYPES.has(field.type);
  const optionsText = (field.options ?? []).join("\n");

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start gap-2">
          <GripVertical className="mt-2 size-4 shrink-0 text-muted-foreground" />
          <div className="grid flex-1 gap-3 sm:grid-cols-[1fr_200px]">
            <div className="space-y-1.5">
              <Label>Question label</Label>
              <Input
                value={field.label}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder="Question"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
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

        <div className="space-y-1.5 pl-6">
          <Label>Help text (optional)</Label>
          <Input
            value={field.help ?? ""}
            onChange={(e) => onChange({ help: e.target.value === "" ? undefined : e.target.value })}
            placeholder="Shown under the question"
          />
        </div>

        {isChoice ? (
          <div className="space-y-1.5 pl-6">
            <Label>Options (one per line)</Label>
            <Textarea
              value={optionsText}
              onChange={(e) =>
                onChange({
                  options: e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter((s) => s !== ""),
                })
              }
              rows={3}
              placeholder={"Option 1\nOption 2"}
            />
          </div>
        ) : null}

        <Separator />

        <div className="flex items-center justify-between pl-6">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => onChange({ required: e.target.checked })}
              className="size-4 rounded border-input"
            />
            Required
          </label>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label="Move up"
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              aria-label="Move down"
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              aria-label="Remove field"
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
