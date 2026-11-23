CREATE TABLE "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"post_id" text,
	"social_account_id" text,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"level" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"content_hash" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "autonomy_level" text DEFAULT 'assisted' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "autonomy_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "autonomy_rules_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "autonomy_suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "autonomy_suspended_reason" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "origin" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "auto_approved_version" integer;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "autonomy_level" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_actions_brand" ON "agent_actions" USING btree ("brand_id","created_at");--> statement-breakpoint
-- RLS pilot (0016): autonomy decisions belong to their organisation.
ALTER TABLE "agent_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_actions" USING (bp_current_org() IS NULL OR "workspace_id" = bp_current_org()) WITH CHECK (bp_current_org() IS NULL OR "workspace_id" = bp_current_org());
