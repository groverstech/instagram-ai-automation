CREATE TABLE "ai_billing" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"confirmed_usd" real NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	"imported_by" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"rates" jsonb NOT NULL,
	"source" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_billing_line" ON "ai_billing" USING btree ("provider","model","period_start","period_end","source");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prices_model_from" ON "ai_prices" USING btree ("model","effective_from");