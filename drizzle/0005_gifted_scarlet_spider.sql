-- Remove 'admin_import_only' from registration_mode enum.
-- PG can't drop an enum value in place, so: drop default → text → collapse leftover value → swap type → restore default.
ALTER TABLE "public"."events" ALTER COLUMN "registration_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."events" ALTER COLUMN "registration_mode" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."events" SET "registration_mode" = 'public_self_register' WHERE "registration_mode" = 'admin_import_only';--> statement-breakpoint
DROP TYPE "public"."registration_mode";--> statement-breakpoint
CREATE TYPE "public"."registration_mode" AS ENUM('public_self_register', 'closed');--> statement-breakpoint
ALTER TABLE "public"."events" ALTER COLUMN "registration_mode" SET DATA TYPE "public"."registration_mode" USING "registration_mode"::"public"."registration_mode";--> statement-breakpoint
ALTER TABLE "public"."events" ALTER COLUMN "registration_mode" SET DEFAULT 'closed';
