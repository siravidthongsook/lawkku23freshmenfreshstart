CREATE TYPE "public"."point_reason" AS ENUM('checkin_in', 'checkin_out', 'assessment_completed', 'staff_grant_qr', 'manual_adjust', 'peer_connect', 'correction_add', 'correction_reverse');--> statement-breakpoint
CREATE TYPE "public"."staff_budget_reason" AS ENUM('topup', 'grant_issue', 'grant_refund', 'manual_grant', 'admin_adjust');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "point_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason_code" "point_reason" NOT NULL,
	"reversal_of_ledger_id" uuid,
	"dedupe_key" text,
	"metadata" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "points_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_positive_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "staff_point_budget" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "point_ledger_user_idx" ON "point_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "point_ledger_dedupe_uq" ON "point_ledger" USING btree ("dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "point_ledger_reversal_uq" ON "point_ledger" USING btree ("reversal_of_ledger_id") WHERE reversal_of_ledger_id is not null;