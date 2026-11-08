CREATE TABLE "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"strategy_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"rev" integer NOT NULL,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"actor_id" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_usd" real;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "account_type" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "revision_note" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "submitted_by" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "brand_ids" jsonb;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_revisions" ADD CONSTRAINT "strategy_revisions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_revisions" ADD CONSTRAINT "strategy_revisions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tasks_brand_idx" ON "ai_tasks" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tasks_strategy_idx" ON "ai_tasks" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "strev_strategy_idx" ON "strategy_revisions" USING btree ("strategy_id","rev");--> statement-breakpoint
CREATE INDEX "strategies_brand_idx" ON "strategies" USING btree ("brand_id","created_at");--> statement-breakpoint
-- Backfill per-brand version numbers for existing (legacy v1) strategies.
UPDATE "strategies" AS s SET "version" = sub.rn, "updated_at" = s."created_at" FROM (SELECT "id", row_number() OVER (PARTITION BY "brand_id" ORDER BY "created_at") AS rn FROM "strategies") AS sub WHERE s."id" = sub."id";
