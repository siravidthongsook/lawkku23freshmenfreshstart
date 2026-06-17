import { z } from "zod";

// Confirm body — scope decides whether we also register imported users to an event.
export const confirmImportSchema = z
  .object({
    importId: z.string().uuid(),
    scope: z.enum(["user_pool_only", "user_pool_and_register_to_event"]),
    targetEventId: z.string().uuid().optional(),
  })
  .refine((v) => v.scope !== "user_pool_and_register_to_event" || !!v.targetEventId, {
    message: "targetEventId is required when registering to an event",
    path: ["targetEventId"],
  });
export type ConfirmImportInput = z.infer<typeof confirmImportSchema>;

// Per-row outcome categories used in both preview and confirm result.
export const ROW_STATUSES = [
  "will_create",
  "will_update",
  "invalid",
  "duplicate_email",
  "duplicate_student_id",
  "will_register_over_capacity",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

// One normalized import row + computed status. Stored in user_imports.result_summary.
export type ImportRow = {
  rowNumber: number;
  email: string;
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
  phone: string | null;
  status: RowStatus;
  note?: string;
};

export type ImportResultSummary = {
  scope: string;
  targetEventId: string | null;
  counts: Record<string, number>;
  rows: ImportRow[];
};
