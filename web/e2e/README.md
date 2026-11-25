# Browser journeys

`lifecycle.cjs` is the whole customer lifecycle in one browser journey (launch-readiness gate Q1):

> sign-up → organisation → brand → profile approved → strategy → approved calendar → content calendar → content and visual for a post → connect a social account → choose the account and time → submit → approve → schedule → the cron scheduler publishes it → metrics sync → Analytics shows the numbers

It runs against a **production build** with:
- **`SOCIAL_SANDBOX=true`:** every platform is simulated (`src/server/social/sandbox.ts`), through the real OAuth callback, publish path, job queue and metrics sync;
- **`AI_PROVIDER=mock`:** demo AI.

Nothing it does reaches a social platform or an AI provider, and **it isn't evidence of a real integration**. Those need the live plans in `docs/PRIVATE_BETA_ROADMAP.md`.

```
npm run build
E2E_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres npm run e2e:lifecycle
```

- **Database:** the runner creates and drops its own database, so the role in `E2E_ADMIN_URL` must be able to create databases.
- **Tools:** it needs `psql` and Playwright with Chromium.
- **CI:** runs it after the production build ("Lifecycle E2E" step).
- **Duration:** about 3 minutes, of which 2 are waiting for the scheduled time.
