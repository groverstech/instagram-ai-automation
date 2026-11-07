ALTER TABLE "assistant_messages" ADD COLUMN "channel" text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "analysis_error" text;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "extracted_text" text;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "section_status" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "description" text;