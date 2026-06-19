ALTER TABLE "login_attempts" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_device_idx" ON "login_attempts" USING btree ("device_id","created_at");