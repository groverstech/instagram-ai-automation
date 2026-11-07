ALTER TABLE "agent_runs" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "run_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "agent_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ai_tasks_due_idx" ON "ai_tasks" USING btree ("status","run_after");