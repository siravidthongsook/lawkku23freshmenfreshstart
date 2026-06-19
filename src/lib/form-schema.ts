import { z } from "zod";

// Shared form-schema contract. forms module builds/stores these; registrations module validates against them.
// Stored in event_form_versions.schema_json (jsonb).

export const FIELD_TYPES = [
  "short_text",
  "paragraph",
  "number",
  "single_choice",
  "multiple_choice",
  "dropdown",
  "checkbox",
  "date",
  "time",
  "file_upload",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const formFieldSchema = z.object({
  key: z.string().min(1), // stable identifier — used as registration_form_answers.field_key
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1),
  help: z.string().optional(),
  required: z.boolean().default(false),
  sort: z.number().int().default(0),
  options: z.array(z.string()).optional(), // for choice/dropdown
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formSchema = z.object({
  fields: z.array(formFieldSchema),
});
export type FormSchema = z.infer<typeof formSchema>;

// Discriminates the two form kinds an event can hold (mirrors the `form_type` pgEnum).
export const FORM_TYPES = ["registration", "assessment"] as const;
export type FormType = (typeof FORM_TYPES)[number];

// Fields whose value is a file id (validated/resolved by uploads module).
export const isFileField = (f: FormField) => f.type === "file_upload";

export type AnswerMap = Record<string, unknown>;

// Validate submitted answers against a form schema. Returns normalized values or field errors.
// File fields are NOT value-checked here (handled by upload endpoint) — only presence if required.
// `allowMissingRequiredFiles`: admin manual-register sends answers BEFORE a registration exists, so a
// required file can't be attached yet — relax the required check for file fields only (the user
// attaches the file afterward). Non-file required fields are still enforced.
export function validateAnswers(
  schema: FormSchema,
  answers: AnswerMap,
  opts?: { allowMissingRequiredFiles?: boolean },
): { ok: true; values: AnswerMap } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: AnswerMap = {};

  // Reject answer keys that aren't defined in the schema (prevents silent drop of stray/spoofed fields).
  const knownKeys = new Set(schema.fields.map((f) => f.key));
  for (const key of Object.keys(answers)) {
    if (!knownKeys.has(key)) errors[key] = "Unknown field";
  }

  for (const f of schema.fields) {
    const raw = answers[f.key];
    const missing = raw === undefined || raw === null || raw === "";

    if (missing) {
      // Allow a missing required FILE field when the caller opts in (admin manual register).
      const fileExempt = opts?.allowMissingRequiredFiles && isFileField(f);
      if (f.required && !fileExempt) errors[f.key] = "Required";
      continue;
    }

    switch (f.type) {
      case "short_text":
      case "paragraph":
      case "date":
      case "time": {
        if (typeof raw !== "string") errors[f.key] = "Must be text";
        else values[f.key] = raw;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (Number.isNaN(n)) errors[f.key] = "Must be a number";
        else values[f.key] = n;
        break;
      }
      case "checkbox": {
        // Explicit truthy set — avoids Boolean("false") === true coercion bug. Everything else is false.
        values[f.key] =
          raw === true || raw === 1 || raw === "true" || raw === "1" || raw === "on";
        break;
      }
      case "single_choice":
      case "dropdown": {
        const opts = f.options ?? [];
        if (typeof raw !== "string" || !opts.includes(raw)) errors[f.key] = "Invalid choice";
        else values[f.key] = raw;
        break;
      }
      case "multiple_choice": {
        const opts = f.options ?? [];
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !opts.includes(v))) {
          errors[f.key] = "Invalid choices";
        } else {
          values[f.key] = raw;
        }
        break;
      }
      case "file_upload": {
        // value = uploaded file id (string). Existence/ownership checked by uploads module.
        if (typeof raw !== "string") errors[f.key] = "Invalid file reference";
        else values[f.key] = raw;
        break;
      }
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values };
}
