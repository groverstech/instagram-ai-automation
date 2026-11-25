-- Privileges for BrandPilot's application database role (staging and production).
--
-- The app must connect as an ordinary role: not a superuser, no BYPASSRLS (docs/RLS_PILOT.md),
-- and not the owner of the tables. Migrations run as the owner (the migrate role). Run this once
-- as the owner, after the first migration, replacing brandpilot_app with your app role:
--
--   psql "$MIGRATE_DATABASE_URL" -v app_role=brandpilot_app -f deploy/app-role-grants.sql
--
-- The default privileges cover tables later migrations create, so a new release needs no new
-- grants as long as the same owner role runs its migrations.

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- Readiness compares the applied migrations with the release's (GET /api/health/ready): the app
-- reads the migration journal, never writes it.
GRANT USAGE ON SCHEMA drizzle TO :"app_role";
GRANT SELECT ON drizzle.__drizzle_migrations TO :"app_role";
