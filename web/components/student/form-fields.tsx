"use client";

// Renders a single form field from the shared FormSchema contract, controlled by the parent's answer
// map. File fields are handled separately (FileField below) because they upload via multipart, not JSON.
import type { FormField } from "@/lib/schemas";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Paperclip } from "lucide-react";

// Shared label row with required marker + optional help text + per-field error.
function FieldLabel({ field, error }: { field: FormField; error?: string }) {
  return (
    <div className="space-y-0.5">
      <Label htmlFor={field.key} className="text-sm font-medium">
        {field.label}
        {field.required && <span className="ml-0.5 text-red-600">*</span>}
      </Label>
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}

type Props = {
  field: FormField;
  value: unknown;
  error?: string;
  onChange: (key: string, value: unknown) => void;
};

// Non-file inputs (file_upload is intentionally excluded — see FileField).
export function FormFieldInput({ field, value, error, onChange }: Props) {
  const set = (v: unknown) => onChange(field.key, v);
  const opts = field.options ?? [];

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} error={error} />

      {(field.type === "short_text" || field.type === "date" || field.type === "time") && (
        <Input
          id={field.key}
          type={field.type === "date" ? "date" : field.type === "time" ? "time" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => set(e.target.value)}
        />
      )}

      {field.type === "paragraph" && (
        <Textarea
          id={field.key}
          rows={4}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => set(e.target.value)}
        />
      )}

      {field.type === "number" && (
        <Input
          id={field.key}
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))}
        />
      )}

      {(field.type === "single_choice" || field.type === "dropdown") && (
        <Select value={typeof value === "string" ? value : ""} onValueChange={set}>
          <SelectTrigger id={field.key}>
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            {opts.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {field.type === "multiple_choice" && (
        <div className="space-y-1.5">
          {opts.map((o) => {
            const selected = Array.isArray(value) && (value as unknown[]).includes(o);
            return (
              <label key={o} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={selected}
                  onChange={(e) => {
                    const current = Array.isArray(value) ? (value as string[]) : [];
                    set(e.target.checked ? [...current, o] : current.filter((v) => v !== o));
                  }}
                />
                {o}
              </label>
            );
          })}
        </div>
      )}

      {field.type === "checkbox" && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={Boolean(value)}
            onChange={(e) => set(e.target.checked)}
          />
          {field.label}
        </label>
      )}
    </div>
  );
}

// File field: shows the current file id (if any) and lets the student pick a new file to upload.
// Upload is deferred to the parent (it must POST multipart per file, replacing the old one).
export function FileField({
  field,
  currentFileId,
  pendingFile,
  error,
  onPick,
}: {
  field: FormField;
  currentFileId: string | null;
  pendingFile: File | null;
  error?: string;
  onPick: (key: string, file: File | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} error={error} />
      <div className="flex items-center gap-2">
        <Input
          id={field.key}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          onChange={(e) => onPick(field.key, e.target.files?.[0] ?? null)}
          className="max-w-sm"
        />
      </div>
      {pendingFile ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="size-3" />
          New file selected: {pendingFile.name}
        </p>
      ) : currentFileId ? (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => window.open(`/api/files/${currentFileId}/download`, "_blank")}
        >
          <Paperclip className="mr-1 size-3" />
          View current file
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">No file uploaded yet.</p>
      )}
      <p className="text-[11px] text-muted-foreground">Allowed: PDF, JPG, PNG (max 5MB).</p>
    </div>
  );
}
