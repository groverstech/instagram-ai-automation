import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who an AI call is for. Set by runAgent (orchestrator.ts) around every agent call, so provider
 * adapters can attribute each attempt in the usage ledger to its organisation, brand, user, task
 * and run without every agent passing it along.
 */
export type AiContext = {
  workspaceId?: string | null;
  brandId?: string | null;
  userId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  /** Provider attempts made in this run (the executor counts; runAgent records it). */
  attempts?: { n: number };
};

const store = new AsyncLocalStorage<AiContext>();

/** Run `fn` with `ctx` merged over the current context. */
export function withAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return store.run({ ...(store.getStore() ?? {}), ...ctx }, fn);
}

export function aiContext(): AiContext {
  return store.getStore() ?? {};
}
