CREATE TABLE "credit_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"brand_id" text DEFAULT '' NOT NULL,
	"monthly_cap_credits" integer NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_value_usd" real NOT NULL,
	"charge_failed_attempts" boolean DEFAULT false NOT NULL,
	"alert_thresholds" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_monthly_usd" real NOT NULL,
	"limits" jsonb NOT NULL,
	"included_credits" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"brand_id" text DEFAULT '' NOT NULL,
	"period" text NOT NULL,
	"threshold" integer NOT NULL,
	"credits_used" real NOT NULL,
	"cap_credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_limits" ADD CONSTRAINT "credit_limits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_limits_scope" ON "credit_limits" USING btree ("workspace_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_alerts_once" ON "usage_alerts" USING btree ("workspace_id","brand_id","period","threshold");--> statement-breakpoint
-- Seed: today's plan values (formerly src/lib/plans.ts). Included credits stay unset until the owner sets them.
INSERT INTO "plans" ("key", "name", "price_monthly_usd", "limits") VALUES
  ('starter', 'Starter', 0, '{"brands":1,"seats":2,"socialAccounts":3,"aiRunsPerMonth":200}'),
  ('growth', 'Growth', 79, '{"brands":3,"seats":5,"socialAccounts":12,"aiRunsPerMonth":2000}'),
  ('agency', 'Agency', 299, '{"brands":25,"seats":25,"socialAccounts":150,"aiRunsPerMonth":20000}')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "credit_settings" ("id", "credit_value_usd", "charge_failed_attempts", "alert_thresholds") VALUES ('default', 0.01, false, '[70,90,100]') ON CONFLICT ("id") DO NOTHING;
