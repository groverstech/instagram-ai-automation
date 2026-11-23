# Row-level security pilot (launch gate S8)

Postgres row-level security is a second layer under the application's own tenant scoping. The application checks stay the primary control and are covered by `audit-access.test.ts`, `review-hardening.test.ts`, `members.test.ts` and others. With RLS active, a query that forgets its organisation filter still can't read or change another organisation's rows.

## What's built

| Part | Where |
|---|---|
| Policies on `brands`, `posts` and `creatives` (`ENABLE` + `FORCE`, so the table owner is covered too) | `drizzle/0016_rls_pilot.sql` |
| `withTenant(workspaceId, fn)`: runs `fn` in a transaction with `app.org_id` set, when `RLS_PILOT=on` | `src/server/db/tenant.ts` |
| Used by the Content Calendar (posts and creatives) and the campaign page (posts, filtered by campaign only) | `app/(app)/calendar`, `app/(app)/campaigns/[id]` |
| Start-up check of the app's database role: superusers and `BYPASSRLS` roles ignore every policy. **In staging and production with `RLS_PILOT=on`, the app refuses to start with such a role** (`RlsNotEffectiveError`; readiness fails), and fails closed if the check can't run. Otherwise it logs `db.role_bypasses_rls` as a warning | `assertRlsEffective`, `checkRlsRole` |

**Policy rule:**
- A row is visible and writable only if `app.org_id` is unset, or it belongs to that organisation:
  - `brands.workspace_id`;
  - for posts and creatives, their brand's `workspace_id`.
- "Unset" keeps today's behaviour everywhere that doesn't use `withTenant`, so the migration is safe to apply in every environment. The pilot is switched on with `RLS_PILOT=on`.

## Results

### Correctness

`src/server/rls-pilot.test.ts` runs on real Postgres, connected as an ordinary role.

- **Randomised data:** 5 organisations with 1–3 brands each, and random posts and creatives.
- **Reads:** under `withTenant`, `select` with **no** organisation filter returns exactly that organisation's brands, posts and creatives.
- **Inserts:** inserting a post for another organisation's brand is refused by Postgres (`new row violates row-level security policy`).
- **Bulk changes:** an `UPDATE … WHERE true` changes only the organisation's own rows. A `DELETE` of another organisation's creative removes nothing.
- **No leaks:** the setting is per transaction, so it never leaks to the next query on a pooled connection.
- **Flag off:** with `RLS_PILOT` off, `withTenant` is a pass-through.
- **Role check:** the start-up check passes for an ordinary role and flags a superuser.

### Cost

Measured on Postgres 16 with 60,000 posts (200 organisations × 3 brands × 100 posts), running the calendar's query (one brand, 40 days) as an ordinary role, 30 runs:

| | Median | p90 |
|---|---|---|
| No organisation set (policy passes) | 1.38 ms | 1.69 ms |
| `app.org_id` set (RLS active) | 1.12 ms | 1.52 ms |

- The planner keeps the `posts_brand_sched_idx` index scan.
- The policy adds one hashed sub-plan on `brands` (via `brands_ws_idx`) that runs once per query: 0.09 ms execution in total.
- The measurable cost is `withTenant`'s transaction: `BEGIN`, `set_config` and `COMMIT` add **three round trips** per call. That's why the pilot groups the calendar's two queries into one call.

### Operational findings

1. **Superusers bypass RLS, even with `FORCE`.**
   - The local test role and CI's `postgres` user are superusers, which is why the pilot test creates an ordinary role.
   - **In production the app must connect as an ordinary role** that isn't a superuser and doesn't have `BYPASSRLS`. The migrate step can keep a privileged role.
   - The start-up warning makes a mistake visible.
2. **PGlite (development and demo) runs as a superuser**, so RLS never applies there. The pilot is a Postgres feature; development behaviour is unchanged.
3. **A finding fixed on the way.** The campaign pages read a campaign's posts **by campaign id only**, and `generateCreativesAction` accepted a campaign id without checking it belonged to the brand.
   - Nothing in the app creates a post that points at another organisation's campaign.
   - Still, the browser check showed a seeded cross-organisation post appearing on the campaign page with RLS off. With RLS on it was hidden.
   - The pages now filter by brand as well, and the action checks the campaign. These are application fixes; RLS remains the second layer.
4. **Background work** (the worker, cron, the CLIs) doesn't set `app.org_id` and sees everything, which it needs. Policies restrict only when an organisation is set.

## Recommendation

1. **Before beta:** run production and staging as an ordinary database role. Grant it table privileges, but no superuser and no `BYPASSRLS`. Turn on `RLS_PILOT=on` in staging first, then production; the pilot paths are read-mostly and have tests.
2. **After beta:**
   - extend `withTenant` to the remaining request-path reads of tenant tables, organisation by organisation, with the same tests;
   - then add policies on the rest of the tenant tables (campaigns, strategies, brand memory and assets, social accounts, usage events);
   - change the rule from "unset means unrestricted" to "unset means nothing" for request traffic, with a separate role for the worker and operators.

   That last change is the step that makes RLS a hard guarantee, and it needs every request path on `withTenant` first.
3. **Independent review (F8):** still needed before launch, as an external check of cross-tenant and cross-brand isolation, including the AI usage ledger.
