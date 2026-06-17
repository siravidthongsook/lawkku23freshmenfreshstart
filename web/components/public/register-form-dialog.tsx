"use client";

// Public registration form step. Renders the event's active form fields, validates locally, then
// hands the answer map back to the parent which POSTs { answers } to /events/:id/register.
// NOTE: there is NO pre-registration upload endpoint (uploads need a registrationId that only exists
// AFTER register — see docs/02 §Uploads). So file fields cannot be satisfied here: a REQUIRED file
// field blocks submit with a clear message; the student edits answers post-register to attach files.
import { useMemo, useState } from "react";
import { isFileField, validateAnswers, type FormSchema, type AnswerMap } from "@/lib/schemas";
import { FormFieldInput } from "@/components/student/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: FormSchema;
  eventTitle: string;
  submitting: boolean;
  onSubmit: (answers: AnswerMap) => void;
};

export function RegisterFormDialog({
  open,
  onOpenChange,
  schema,
  eventTitle,
  submitting,
  onSubmit,
}: Props) {
  const [values, setValues] = useState<AnswerMap>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Sorted fields; file fields can't be uploaded pre-registration (no registrationId yet).
  const fields = useMemo(() => [...schema.fields].sort((a, b) => a.sort - b.sort), [schema]);
  const requiredFileFields = useMemo(
    () => schema.fields.filter((f) => isFileField(f) && f.required),
    [schema],
  );
  const hasFileField = useMemo(() => schema.fields.some(isFileField), [schema]);
  const blockedByFile = requiredFileFields.length > 0;

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit() {
    if (blockedByFile) return; // guard: required file field can't be satisfied pre-registration
    setFieldErrors({});
    const result = validateAnswers(schema, values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    onSubmit(result.values);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register for {eventTitle}</DialogTitle>
          <DialogDescription>Please fill in the registration form below.</DialogDescription>
        </DialogHeader>

        {/* Backend gap: file uploads require a registration to exist first. */}
        {blockedByFile ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This form requires a file upload, which isn&apos;t supported during registration yet.
            Please contact the organizers.
          </p>
        ) : null}

        <div className="space-y-5 py-1">
          {fields.map((field) =>
            isFileField(field) ? (
              // Optional file field: shown but not collectable here; attach after registering.
              <div key={field.key} className="space-y-1">
                <p className="text-sm font-medium">{field.label}</p>
                <p className="text-xs text-muted-foreground">
                  You can attach this file after registering, from your registration page.
                </p>
              </div>
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
          {hasFileField && !blockedByFile ? (
            <p className="text-xs text-muted-foreground">
              File uploads can be added after you register.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={submitting || blockedByFile} onClick={handleSubmit}>
            {submitting ? "Registering…" : "Submit & register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
