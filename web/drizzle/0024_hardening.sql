-- Pre-beta hardening (review findings H1, L4, L6).
-- H1: the hash of exactly what was approved. Posts approved before this have none and need a
-- fresh approval before they can publish (the publish claim fails closed).
ALTER TABLE "posts" ADD COLUMN "approved_content_hash" text;--> statement-breakpoint
-- L4: one pending invitation per organisation and address. Older duplicates (possible before this
-- constraint) are removed first, keeping the newest one.
DELETE FROM "workspace_members" a USING "workspace_members" b
  WHERE a."status" = 'invited' AND a."user_id" IS NULL AND b."status" = 'invited' AND b."user_id" IS NULL
    AND a."workspace_id" = b."workspace_id" AND a."invited_email" = b."invited_email"
    AND (a."created_at" < b."created_at" OR (a."created_at" = b."created_at" AND a."id" < b."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "wm_pending_invite_uq" ON "workspace_members" USING btree ("workspace_id","invited_email") WHERE "workspace_members"."status" = 'invited' and "workspace_members"."user_id" is null;--> statement-breakpoint
-- L6: agent_actions is append-only for the application. A direct UPDATE or DELETE is refused;
-- changes made by foreign-key actions (a brand, organisation or post being deleted) are allowed,
-- because they run one trigger level deeper. A database owner or superuser can still disable the
-- trigger: this is protection against the application, not against the database administrator.
CREATE OR REPLACE FUNCTION bp_agent_actions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'agent_actions is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "agent_actions_append_only" BEFORE UPDATE OR DELETE ON "agent_actions" FOR EACH ROW EXECUTE FUNCTION bp_agent_actions_append_only();
