import { z } from "zod";

// Zod boundary schemas for the events module. Infer TS types from these — no hand-written dups.

export const eventStatusEnum = z.enum(["draft", "published", "cancelled", "archived"]);
export const eventVisibilityEnum = z.enum(["listed", "unlisted"]);
export const registrationModeEnum = z.enum([
  "public_self_register",
  "admin_import_only",
  "closed",
]);

// Coerce ISO-8601 strings → Date (wire format is UTC ISO-8601). Nullable to allow clearing windows.
const isoDateTime = z.coerce.date();
const isoDateTimeNullable = z.coerce.date().nullable();

// Shared editable config fields (used by create + patch). All optional on patch.
const eventConfigShape = {
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  // Poster render URL (static path or serve endpoint). Upload endpoint sets it from the stored file.
  posterImageUrl: z.string().max(1000).nullable().optional(),
  registrationMode: registrationModeEnum.optional(),
  registrationOpenAt: isoDateTimeNullable.optional(),
  registrationCloseAt: isoDateTimeNullable.optional(),
  checkinOpenAt: isoDateTimeNullable.optional(),
  checkinCloseAt: isoDateTimeNullable.optional(),
  eventStartAt: isoDateTimeNullable.optional(),
  eventEndAt: isoDateTimeNullable.optional(),
  capacityEnabled: z.boolean().optional(),
  capacityLimit: z.number().int().positive().nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  allowStudentCancelRegistration: z.boolean().optional(),
  cancelRegistrationCloseAt: isoDateTimeNullable.optional(),
  allowStudentEditRegistration: z.boolean().optional(),
  editRegistrationCloseAt: isoDateTimeNullable.optional(),
};

// Create: title required; slug optional (auto from title when absent).
export const createEventSchema = z.object({
  ...eventConfigShape,
  title: z.string().min(1).max(300),
  publicSlug: z.string().min(1).max(120).optional(),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

// Patch: every field optional; slug editable here.
export const updateEventSchema = z
  .object({
    ...eventConfigShape,
    title: z.string().min(1).max(300).optional(),
    publicSlug: z.string().min(1).max(120).optional(),
  })
  .strict();
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const statusChangeSchema = z.object({
  status: eventStatusEnum,
  reason: z.string().max(1000).optional(),
});

export const visibilityChangeSchema = z.object({
  visibility: eventVisibilityEnum,
  reason: z.string().max(1000).optional(),
});

// Admin list query: free-text title/slug search + status filter + pagination. All optional.
export const adminEventsQuerySchema = z.object({
  q: z.string().trim().max(300).optional(),
  status: eventStatusEnum.optional(),
  // Sort: event-date desc/asc, title, or created. Default newest event date first.
  sort: z
    .enum(["date_desc", "date_asc", "title_asc", "created_desc"])
    .default("date_desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminEventsQuery = z.infer<typeof adminEventsQuerySchema>;

export const eventIdParam = z.object({ eventId: z.string().uuid() });
export const slugParam = z.object({ slug: z.string().min(1) });
export const publicIdParam = z.object({ publicId: z.string().uuid() });

export { isoDateTime };
