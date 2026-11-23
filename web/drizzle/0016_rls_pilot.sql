-- Row-level security pilot (launch gate S8; docs/RLS_PILOT.md). Defence in depth under the
-- application's own scoping, on three hot tenant tables. A policy restricts rows only when the
-- transaction has set app.org_id (withTenant in src/server/db/tenant.ts, behind RLS_PILOT=on);
-- without it, behaviour is unchanged, so this migration is safe to apply everywhere.
-- FORCE applies the policies to the table owner too. Superusers and BYPASSRLS roles are never
-- subject to RLS: the app must not connect as one (a warning is logged at start-up).
CREATE OR REPLACE FUNCTION bp_current_org() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')
$$;--> statement-breakpoint
ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "brands" USING (bp_current_org() IS NULL OR "workspace_id" = bp_current_org()) WITH CHECK (bp_current_org() IS NULL OR "workspace_id" = bp_current_org());--> statement-breakpoint
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "posts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "posts" USING (bp_current_org() IS NULL OR "brand_id" IN (SELECT "id" FROM "brands" WHERE "workspace_id" = bp_current_org())) WITH CHECK (bp_current_org() IS NULL OR "brand_id" IN (SELECT "id" FROM "brands" WHERE "workspace_id" = bp_current_org()));--> statement-breakpoint
ALTER TABLE "creatives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "creatives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "creatives" USING (bp_current_org() IS NULL OR "brand_id" IN (SELECT "id" FROM "brands" WHERE "workspace_id" = bp_current_org())) WITH CHECK (bp_current_org() IS NULL OR "brand_id" IN (SELECT "id" FROM "brands" WHERE "workspace_id" = bp_current_org()));
