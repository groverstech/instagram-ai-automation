CREATE TABLE "ai_task_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE INDEX "leases_ws_idx" ON "ai_task_leases" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "leases_user_idx" ON "ai_task_leases" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "rlb_window_idx" ON "rate_limit_buckets" USING btree ("window_start");