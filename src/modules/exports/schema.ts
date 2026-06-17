import { z } from "zod";

// Shared export filters (query string). All optional. date_range filters registered_at by default.
export const exportFiltersSchema = z.object({
  status: z.enum(["registered", "waitlisted", "checked_in", "cancelled"]).optional(),
  from: z.string().datetime().optional(), // ISO-8601 UTC
  to: z.string().datetime().optional(),
  form_version: z.string().uuid().optional(),
});
export type ExportFilters = z.infer<typeof exportFiltersSchema>;
