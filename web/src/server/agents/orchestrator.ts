import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { AGENTS, type AgentId } from "./registry";
import { usageFromError, withRetry, type Usage } from "../ai/llm";
import { classify } from "../ai/errors";
import { withAiContext } from "../ai/context";
import { addUsage, estimateCost } from "../ai/pricing";

export type RunScope = { brandId: string; userId: string; parentId?: string; taskId?: string };

/**
 * Every agent call goes through here: it is logged to agent_runs (the activity feed and
 * audit trail), timed, and failures are recorded with their message. Provider calls made inside
 * `fn` are attributed to this run, brand, organisation and user in the usage ledger
 * (usage_events) through the AI context.
 */
export async function runAgent<T>(
  scope: RunScope,
  agent: AgentId,
  task: string,
  input: unknown,
  fn: (runId: string) => Promise<{ data: T; usage?: Usage; provider?: string }>,
  opts: { retries?: number } = {},
): Promise<{ runId: string; data: T; provider?: string; usage?: Usage; costUsd: number }> {
  const db = await getDb();
  const [brand] = await db.select({ workspaceId: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, scope.brandId));
  const workspaceId = brand?.workspaceId ?? null;
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ brandId: scope.brandId, userId: scope.userId, workspaceId, parentId: scope.parentId, taskId: scope.taskId ?? null, agent, task, input: input ?? null })
    .returning({ id: schema.agentRuns.id });
  // Usage is summed over every attempt the provider billed. Provider calls report the total of
  // their own attempts (call.ts): billed failures (refusal, truncation, invalid output) and
  // attempts whose outcome is unknown (sent, no response) included. Each call is added once.
  let attempts = 0;
  // Provider attempts inside fn (counted by the executor), for agent_runs.attempts.
  const providerAttempts = { n: 0 };
  let billed: Usage = {};
  let billedAny = false;
  try {
    const { data, usage, provider } = await withRetry(
      async () => {
        attempts++;
        try {
          return await withAiContext({ workspaceId, brandId: scope.brandId, userId: scope.userId, taskId: scope.taskId ?? null, runId: run.id, attempts: providerAttempts }, () => fn(run.id));
        } catch (e) {
          const u = usageFromError(e);
          if (u) {
            billed = addUsage(billed, u);
            billedAny = true;
          } else if (classify(e).outcomeUnknown) {
            // Sent, but no response, outside the executor: the provider may have billed it.
            billed = addUsage(billed, { unknownUsageAttempts: 1 });
            billedAny = true;
          }
          throw e;
        }
      },
      { attempts: 1 + (opts.retries ?? 0) },
    );
    if (usage) {
      billed = addUsage(billed, usage);
      billedAny = true;
    }
    const total = billedAny ? billed : undefined;
    const costUsd = estimateCost(total);
    await db
      .update(schema.agentRuns)
      .set({ status: "succeeded", output: data as unknown, usage: total ?? null, provider, model: total?.model ?? null, costUsd, attempts: Math.max(attempts, providerAttempts.n), finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    return { runId: run.id, data, provider, usage: total, costUsd };
  } catch (e) {
    const total = billedAny ? billed : undefined;
    await db
      .update(schema.agentRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e), usage: total ?? null, model: total?.model ?? null, costUsd: total ? estimateCost(total) : null, attempts: Math.max(attempts, providerAttempts.n), finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    throw e;
  }
}

export async function recentRuns(brandId: string, limit = 12) {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.agentRuns.id,
      agent: schema.agentRuns.agent,
      task: schema.agentRuns.task,
      status: schema.agentRuns.status,
      error: schema.agentRuns.error,
      provider: schema.agentRuns.provider,
      startedAt: schema.agentRuns.startedAt,
      finishedAt: schema.agentRuns.finishedAt,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.brandId, brandId))
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, agentName: AGENTS[r.agent as AgentId]?.name ?? r.agent }));
}
