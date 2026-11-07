import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { AGENTS, type AgentId } from "./registry";
import type { Usage } from "../ai/llm";

export type RunScope = { brandId: string; userId: string; parentId?: string };

/**
 * Every agent call goes through here: it is logged to agent_runs (the activity feed and
 * audit trail), timed, and failures are recorded with their message.
 */
export async function runAgent<T>(
  scope: RunScope,
  agent: AgentId,
  task: string,
  input: unknown,
  fn: (runId: string) => Promise<{ data: T; usage?: Usage; provider?: string }>,
): Promise<{ runId: string; data: T; provider?: string }> {
  const db = await getDb();
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ brandId: scope.brandId, userId: scope.userId, parentId: scope.parentId, agent, task, input: input ?? null })
    .returning({ id: schema.agentRuns.id });
  try {
    const { data, usage, provider } = await fn(run.id);
    await db
      .update(schema.agentRuns)
      .set({ status: "succeeded", output: data as unknown, usage: usage ?? null, provider, finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    return { runId: run.id, data, provider };
  } catch (e) {
    await db
      .update(schema.agentRuns)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() })
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
