ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "nickname" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mentor_role" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "group_number" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");