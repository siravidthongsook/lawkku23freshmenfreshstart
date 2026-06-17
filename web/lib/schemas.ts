// Single import surface for shared Zod schemas + inferred types. Re-exported from backend (@be/*).
// These backend files import ONLY `zod` — safe in the browser. Do NOT duplicate schemas here.
// Frontend-only response shapes live in @/lib/types.

// Auth
export { loginSchema, changePasswordSchema } from "@be/modules/auth/schema";
export type { LoginInput, ChangePasswordInput } from "@be/modules/auth/schema";

// Users
export {
  listUsersQuery,
  createUserSchema,
  updateUserSchema,
  reasonSchema,
  changeRoleSchema,
} from "@be/modules/users/schema";
export type { ListUsersQuery, CreateUserInput, UpdateUserInput } from "@be/modules/users/schema";

// Events
export {
  eventStatusEnum,
  eventVisibilityEnum,
  registrationModeEnum,
  createEventSchema,
  updateEventSchema,
  statusChangeSchema,
  visibilityChangeSchema,
} from "@be/modules/events/schema";
export type { CreateEventInput, UpdateEventInput } from "@be/modules/events/schema";

// Forms (shared form-schema contract: fields, validation)
export {
  FIELD_TYPES,
  formFieldSchema,
  formSchema,
  isFileField,
  validateAnswers,
} from "@be/lib/form-schema";
export type { FieldType, FormField, FormSchema, AnswerMap } from "@be/lib/form-schema";
export { updateFormSchema, createVersionSchema } from "@be/modules/forms/schema";

// Imports
export { confirmImportSchema, ROW_STATUSES } from "@be/modules/imports/schema";
export type {
  ConfirmImportInput,
  RowStatus,
  ImportRow,
  ImportResultSummary,
} from "@be/modules/imports/schema";

// Exports
export { exportFiltersSchema } from "@be/modules/exports/schema";
export type { ExportFilters } from "@be/modules/exports/schema";
