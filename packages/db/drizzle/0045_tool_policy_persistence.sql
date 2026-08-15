DO $$ BEGIN
 CREATE TYPE "public"."tool_policy" AS ENUM('always_allow', 'needs_approval', 'blocked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."tool_policy_audit_decision" AS ENUM('auto_allowed', 'approved_by_user', 'denied', 'blocked', 'would_need_approval', 'would_block', 'uncataloged_would_need_approval');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "tools_catalog" ADD COLUMN IF NOT EXISTS "policy" "tool_policy";--> statement-breakpoint
UPDATE "tools_catalog"
SET "policy" = CASE "action"
  WHEN 'read' THEN 'always_allow'::"tool_policy"
  WHEN 'admin' THEN 'blocked'::"tool_policy"
  ELSE 'needs_approval'::"tool_policy"
END
WHERE "policy" IS NULL;--> statement-breakpoint
ALTER TABLE "tools_catalog" ALTER COLUMN "policy" SET DEFAULT 'needs_approval';--> statement-breakpoint
ALTER TABLE "tools_catalog" ALTER COLUMN "policy" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "policy_decision" "tool_policy_audit_decision";
