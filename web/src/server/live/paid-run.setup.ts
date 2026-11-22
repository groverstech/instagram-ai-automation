// Runs before every *.live.ts file (vitest.live.config.ts setupFiles), before any test code.
// Refuses the whole run unless a valid spending cap is set, the usage ledger is persistent and
// the cap isn't already used up; then blocks any provider request that doesn't hold a
// reservation under the cap. See src/server/ai/paid-run-guard.ts.
import { PaidRunRefused, installPaidRequestGuard, preparePaidRun } from "../ai/paid-run-guard";

try {
  const budget = await preparePaidRun();
  await installPaidRequestGuard();
  console.log(
    `Spending cap: $${budget.capUsd.toFixed(2)} since ${budget.since}; recorded so far about $${budget.committedUsd.toFixed(4)}, remaining about $${budget.remainingUsd.toFixed(4)} (${budget.pendingAttempts} pending).\n${budget.coverage}`,
  );
} catch (e) {
  if (e instanceof PaidRunRefused) throw new Error(`Refusing to run live provider tests: ${e.message}`);
  throw e;
}
