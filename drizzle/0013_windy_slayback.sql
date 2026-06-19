CREATE TABLE IF NOT EXISTS "peer_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scanner_user_id" uuid NOT NULL,
	"scanned_user_id" uuid NOT NULL,
	"favorited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_conn_pair_uq" UNIQUE("scanner_user_id","scanned_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_connect_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"status" "qr_token_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_connect_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_connections" ADD CONSTRAINT "peer_connections_scanner_user_id_users_id_fk" FOREIGN KEY ("scanner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "peer_connections" ADD CONSTRAINT "peer_connections_scanned_user_id_users_id_fk" FOREIGN KEY ("scanned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_connect_tokens" ADD CONSTRAINT "user_connect_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_conn_scanner_idx" ON "peer_connections" USING btree ("scanner_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_conn_fav_idx" ON "peer_connections" USING btree ("scanner_user_id","favorited_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connect_one_active_uq" ON "user_connect_tokens" USING btree ("user_id") WHERE status = 'active';