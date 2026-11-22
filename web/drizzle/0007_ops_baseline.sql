CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"brand_id" text,
	"actor_user_id" text,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"outcome" text DEFAULT 'success' NOT NULL,
	"ip_hash" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_ws_time_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_brand_time_idx" ON "audit_events" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_time_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "campaigns_brand_idx" ON "campaigns" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "competitors_brand_idx" ON "competitors" USING btree ("brand_id");