import { z } from "zod";

// Confirm body — only the importId. scope/targetEventId are derived from the persisted previewed
// batch (BUG B fix): confirm applies EXACTLY what preview analyzed, never body-supplied scope/event.
export const confirmImportSchema = z.object({
  importId: z.string().uuid(),
});
export type ConfirmImportInput = z.infer<typeof confirmImportSchema>;

// Result-CSV query — mirrors the users-export reveal contract (src/modules/users): temp_password is
// opt-in ONLY (default omits the column, never leaks plaintext) and the reason is enforced in-handler.
export const importResultQuery = z.object({
  // include_temp_password=true opts into decrypting the per-created-user temp pw on demand.
  include_temp_password: z
    .preprocess((v) => v === "true" || v === true, z.boolean())
    .optional(),
  // Required ONLY when include_temp_password is set (enforced in handler, mirrors users export).
  reason: z.string().trim().optional(),
});
export type ImportResultQuery = z.infer<typeof importResultQuery>;

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

// Per-row CONFIRM outcome. NEVER carries a plaintext secret (BUG A fix) — created rows store the
// new userId so the result endpoint can decrypt the temp pw on demand from temporaryPasswords.
export type ImportResultRow = ImportRow & {
  result: string;
  userId?: string;
};

export type ImportResultSummary = {
  scope: string;
  targetEventId: string | null;
  counts: Record<string, number>;
  rows: ImportRow[];
  // Present only on confirmed batches: per-row outcome with userId (no plaintext temp pw).
  result?: ImportResultRow[];
};
