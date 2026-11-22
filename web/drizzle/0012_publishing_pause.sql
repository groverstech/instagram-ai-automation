ALTER TABLE "brands" ADD COLUMN "publishing_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "publishing_paused_by" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "publishing_pause_reason" text;