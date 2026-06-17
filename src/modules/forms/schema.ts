import { z } from "zod";
import { formSchema } from "../../lib/form-schema";

// Zod boundary for forms module. Reuse shared formSchema — do NOT redefine field types.

export const eventIdParam = z.object({ eventId: z.string().uuid() });

// PATCH body: a full replacement schema_json. Service decides safe-edit vs new-version.
export const updateFormSchema = z.object({
  schema: formSchema,
});

// POST version body: explicit new version with its schema_json.
export const createVersionSchema = z.object({
  schema: formSchema,
  reason: z.string().max(1000).optional(),
});
