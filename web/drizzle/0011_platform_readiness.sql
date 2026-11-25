CREATE TABLE "data_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_user_id" text NOT NULL,
	"confirmation_code" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "data_deletion_requests_confirmation_code_unique" UNIQUE("confirmation_code")
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "platform_user_id" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "deauthorized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "acct_platform_user" ON "social_accounts" USING btree ("platform","platform_user_id");