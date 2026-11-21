CREATE TABLE "ai_ledger_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "reserve_usd" real;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "usage_time_idx" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
INSERT INTO "ai_ledger_meta" ("key") VALUES ('ledger') ON CONFLICT DO NOTHING;
