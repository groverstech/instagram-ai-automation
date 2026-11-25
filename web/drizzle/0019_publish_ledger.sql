CREATE TABLE "publish_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"social_account_id" text,
	"platform" text NOT NULL,
	"attempt" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "publish_attempts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "health" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_attempts_post" ON "publish_attempts" USING btree ("post_id","attempt");