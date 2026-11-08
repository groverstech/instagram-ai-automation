ALTER TABLE "creatives" ADD COLUMN "kind" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "slides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "copy" jsonb;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "brand_check" jsonb;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "visual_source" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "source_asset_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "logo_placement" text DEFAULT 'top_left' NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "strategy_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "calendar_entry_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "creatives_task_idx" ON "creatives" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "creatives_strategy_idx" ON "creatives" USING btree ("strategy_id","calendar_entry_id");--> statement-breakpoint
-- Existing creatives without an AI image were rendered typographically.
UPDATE "creatives" SET "visual_source" = 'typographic' WHERE "image_path" IS NULL AND ("image_provider" = 'none' OR "image_provider" IS NULL);
