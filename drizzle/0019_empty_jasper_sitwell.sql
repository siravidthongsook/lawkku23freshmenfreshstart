CREATE TYPE "public"."registration_source" AS ENUM('normal', 'walkin');--> statement-breakpoint
ALTER TYPE "public"."checkin_method" ADD VALUE 'walkin';--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "registration_source" "registration_source" DEFAULT 'normal' NOT NULL;