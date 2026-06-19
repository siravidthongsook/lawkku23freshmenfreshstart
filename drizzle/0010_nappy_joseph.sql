CREATE TABLE IF NOT EXISTS "event_point_config" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"checkin_in_enabled" boolean DEFAULT true NOT NULL,
	"checkin_out_enabled" boolean DEFAULT false NOT NULL,
	"assessment_enabled" boolean DEFAULT false NOT NULL,
	"assessment_requires_checkin" boolean DEFAULT true NOT NULL,
	"checkin_in_points" integer,
	"checkin_out_points" integer,
	"assessment_points" integer,
	"scan_in_open_at" timestamp with time zone,
	"scan_in_close_at" timestamp with time zone,
	"scan_out_open_at" timestamp with time zone,
	"scan_out_close_at" timestamp with time zone,
	"assessment_open_at" timestamp with time zone,
	"assessment_close_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "point_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"cutoff_at" timestamp with time zone,
	"default_checkin_in_points" integer DEFAULT 20 NOT NULL,
	"default_checkin_out_points" integer DEFAULT 20 NOT NULL,
	"default_assessment_points" integer DEFAULT 100 NOT NULL,
	"scan_out_fallback_hours" integer DEFAULT 3 NOT NULL,
	"peer_enabled" boolean DEFAULT true NOT NULL,
	"peer_points" integer DEFAULT 5 NOT NULL,
	"peer_cooldown_sec" integer DEFAULT 60 NOT NULL,
	"staff_reverse_window_min" integer DEFAULT 15 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "checked_out_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_point_config" ADD CONSTRAINT "event_point_config_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "registrations" ADD CONSTRAINT "registrations_checked_out_by_user_id_users_id_fk" FOREIGN KEY ("checked_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
