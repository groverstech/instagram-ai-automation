-- Row-level security pilot, extended to the publish ledger (PR 4.4a, migration 0019): an attempt
-- belongs to its post's brand's organisation. Same rule as 0016: restrictive only when the
-- transaction sets app.org_id (withTenant), so behaviour elsewhere is unchanged. The sub-select
-- reads posts and brands, whose own policies apply too, which is consistent.
ALTER TABLE "publish_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publish_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "publish_attempts" USING (bp_current_org() IS NULL OR "post_id" IN (SELECT p."id" FROM "posts" p JOIN "brands" b ON b."id" = p."brand_id" WHERE b."workspace_id" = bp_current_org())) WITH CHECK (bp_current_org() IS NULL OR "post_id" IN (SELECT p."id" FROM "posts" p JOIN "brands" b ON b."id" = p."brand_id" WHERE b."workspace_id" = bp_current_org()));
