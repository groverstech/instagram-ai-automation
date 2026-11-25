CREATE TABLE "credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period" text NOT NULL,
	"credits" integer NOT NULL,
	"kind" text NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_grants_ws_period" ON "credit_grants" USING btree ("workspace_id","period");--> statement-breakpoint
-- RLS pilot (0016): grants belong to their organisation.
ALTER TABLE "credit_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_grants" USING (bp_current_org() IS NULL OR "workspace_id" = bp_current_org()) WITH CHECK (bp_current_org() IS NULL OR "workspace_id" = bp_current_org());
