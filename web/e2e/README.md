# Browser journeys

`lifecycle.cjs` is the whole customer lifecycle in one browser journey (launch-readiness gate Q1):

> sign-up → email verification (the app is closed until then) → organisation → brand → profile approved → strategy → approved calendar → content calendar → content and visual for a post → connect a social account → choose the account and time → submit → approve → schedule → the cron scheduler publishes it → publish attempt recorded and shown in the post's history → metrics sync → Analytics shows the numbers → Settings shows Assisted in effect and Autonomous unavailable → organisation export contains the post and its attempts, and no tokens or password hashes → invite a teammate → they sign up with that address, can't join before verifying, verify and join as an editor

It runs against a **production build** with:
- **`SOCIAL_SANDBOX=true`:** every platform is simulated (`src/server/social/sandbox.ts`), through the real OAuth callback, publish path, job queue and metrics sync;
- **`AI_PROVIDER=mock`:** demo AI;
- **`EMAIL_PROVIDER=file`** and **`EMAIL_VERIFICATION=required`:** emails go to a local outbox that the journey reads, like an inbox.

Nothing it does reaches a social platform or an AI provider, and **it isn't evidence of a real integration**. Those need the live plans in `docs/PRIVATE_BETA_ROADMAP.md`.

```
npm run build
E2E_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres npm run e2e:lifecycle
```

- **Database:** the runner creates and drops its own database, so the role in `E2E_ADMIN_URL` must be able to create databases.
- **Tools:** it needs `psql` and Playwright with Chromium.
- **CI:** runs it after the production build ("Lifecycle E2E" step).
- **Duration:** about 3 minutes, of which 2 are waiting for the scheduled time.
- **Port:** it refuses to start if the port (default 3100) is already in use. The server runs in its own process group, and the whole group is stopped at the end, so no server is left behind to answer the next run.
- **On failure:** it saves `failure.png` in the screenshots directory.
