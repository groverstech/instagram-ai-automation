CREATE TABLE "ai_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"model" text,
	"params" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"brand_id" text,
	"user_id" text,
	"task_id" text,
	"run_id" text,
	"route" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"kind" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"error_kind" text,
	"http_status" integer,
	"units" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" real,
	"price_source" text,
	"provider_request_id" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "workspace_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_routes_scope_key" ON "ai_routes" USING btree ("key","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "usage_ws_time_idx" ON "usage_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_brand_time_idx" ON "usage_events" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_run_idx" ON "usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_ws_idx" ON "agent_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
-- Backfill: existing runs belong to their brand's workspace.
UPDATE "agent_runs" SET "workspace_id" = "brands"."workspace_id" FROM "brands" WHERE "agent_runs"."brand_id" = "brands"."id" AND "agent_runs"."workspace_id" IS NULL;