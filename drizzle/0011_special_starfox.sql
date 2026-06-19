CREATE TYPE "public"."form_type" AS ENUM('registration', 'assessment');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessment_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_ans_sub_field_uq" UNIQUE("submission_id","field_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessment_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_sub_event_user_uq" UNIQUE("event_id","user_id")
);
--> statement-breakpoint
-- EXPAND-ONLY ORDER (hand-edited, see plan §3/§15.6). Auto-rollback is code-only, so this must be
-- safe while OLD code (which only writes form_type='registration') still runs:
--   1) ADD COLUMN form_type DEFAULT 'registration' NOT NULL → Postgres backfills every existing row.
--   2) CREATE the new (event_id, form_type[, version_number]) uniques — they enforce the OLD guarantee
--      for the only type old code touches (registration), so the old uniques become redundant.
--   3) DROP the old (event_id)-only uniques LAST — never a gap with no uniqueness in force.
-- Drizzle generated the drops FIRST (unsafe); reordered by hand.
ALTER TABLE "event_form_versions" ADD COLUMN "form_type" "form_type" DEFAULT 'registration' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_submission_id_assessment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."assessment_submissions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_form_version_id_event_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."event_form_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_submissions" ADD CONSTRAINT "assessment_submissions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_submissions" ADD CONSTRAINT "assessment_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_submissions" ADD CONSTRAINT "assessment_submissions_form_version_id_event_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."event_form_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Step 2: create the new uniques BEFORE dropping the old ones (no uniqueness gap).
CREATE UNIQUE INDEX IF NOT EXISTS "event_form_versions_one_active_uq_new" ON "event_form_versions" USING btree ("event_id","form_type") WHERE is_active;--> statement-breakpoint
ALTER TABLE "event_form_versions" ADD CONSTRAINT "event_form_versions_event_version_uq_new" UNIQUE("event_id","form_type","version_number");--> statement-breakpoint
-- Step 3: drop the old (event_id)-only uniques now that the new ones cover the registration guarantee.
ALTER TABLE "event_form_versions" DROP CONSTRAINT "event_form_versions_event_version_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "event_form_versions_one_active_uq";--> statement-breakpoint
-- Rename the new objects to the canonical names the schema/drizzle expects (so snapshots match).
ALTER INDEX "event_form_versions_one_active_uq_new" RENAME TO "event_form_versions_one_active_uq";--> statement-breakpoint
ALTER TABLE "event_form_versions" RENAME CONSTRAINT "event_form_versions_event_version_uq_new" TO "event_form_versions_event_version_uq";
