DO $$ BEGIN
 CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "role" = 'admin' WHERE "is_admin" = true;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_admin";
