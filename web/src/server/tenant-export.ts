import "server-only";
import JSZip from "jszip";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { requireWorkspaceRoleForUser, AccessError } from "./auth/guard";
import { requireRecentSecondFactor } from "./auth/step-up";
import type { SessionUser } from "./auth/session";
import { enforce } from "./ratelimit";
import { audit } from "./audit";
import { storage } from "./storage";
import { log } from "./log";

/**
 * Organisation data export (launch gate D4; data portability). Owners only, with a recent second
 * factor; rate-limited; audited as `workspace.export`. A ZIP with:
 *   data.json   the organisation, its members and every brand's data (profiles, memory, strategies,
 *               campaigns, creatives, posts and metrics, competitors, assistant history, AI tasks
 *               and usage, credit caps and alerts)
 *   files/…     uploaded brand assets and AI-generated images, at their storage paths
 *   README.txt  what's included and what isn't
 * Never included: passwords, two-step secrets, session ids, social-account tokens, embeddings and
 * internal claim tokens (stripped by column name, so a new secret column named the usual way is
 * excluded too). The Security log has its own export (Settings → Security log).
 */

/**
 * Files beyond this total are listed in the manifest as skipped rather than bundled. The archive is
 * built in memory, so peak use is about twice this; EXPORT_FILE_BUDGET_MB (default 100, 10–1000)
 * sets it. Only one export runs at a time per server process (see exportSlot).
 */
export function exportFileBudgetBytes(env: Record<string, string | undefined> = process.env) {
  const n = Number((env.EXPORT_FILE_BUDGET_MB ?? "").trim() || "100");
  const mb = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 10), 1000) : 100;
  return mb * 1024 * 1024;
}

export class ExportBusyError extends Error {
  constructor() {
    super("Another data export is being prepared on this server. Try again in a minute.");
  }
}
let exporting = false;
/** Run `fn` holding this process's single export slot; ExportBusyError if it's taken. */
export async function exportSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (exporting) throw new ExportBusyError();
  exporting = true;
  try {
    return await fn();
  } finally {
    exporting = false;
  }
}

const STRIP = /(Enc|Hash|Token|Secret)$|^(embedding|claimToken|input|output)$/;
export function stripSecrets<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !STRIP.test(k)));
}

export class ExportError extends Error {}

export async function exportWorkspaceFor(session: SessionUser, workspaceId: string, opts: { fileBudgetBytes?: number } = {}) {
  const { role, brandIds: scope } = await requireWorkspaceRoleForUser(session, workspaceId, "owner");
  if (role !== "owner" || Array.isArray(scope)) throw new AccessError("Only organisation owners can export all of its data.");
  await requireRecentSecondFactor(session);
  // One export at a time per process: each holds its files and the archive in memory.
  return exportSlot(async () => {
    await enforce("export", { userId: session.user.id });
    return buildExport(workspaceId, session.user.id, opts.fileBudgetBytes ?? exportFileBudgetBytes());
  });
}

/** Before downloading: owner, recent second factor (so the app can ask for a code first). */
export async function exportReadyFor(session: SessionUser, workspaceId: string) {
  const { role, brandIds: scope } = await requireWorkspaceRoleForUser(session, workspaceId, "owner");
  if (role !== "owner" || Array.isArray(scope)) throw new AccessError("Only organisation owners can export all of its data.");
  await requireRecentSecondFactor(session);
}

async function buildExport(workspaceId: string, actorUserId: string, budget: number) {
  const db = await getDb();
  const s = schema;
  const [ws] = await db.select().from(s.workspaces).where(eq(s.workspaces.id, workspaceId));
  if (!ws) throw new ExportError("Workspace not found.");
  const members = await db
    .select({ name: s.users.name, email: s.users.email, invitedEmail: s.workspaceMembers.invitedEmail, role: s.workspaceMembers.role, status: s.workspaceMembers.status, brandIds: s.workspaceMembers.brandIds, joinedAt: s.workspaceMembers.createdAt })
    .from(s.workspaceMembers)
    .leftJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
    .where(eq(s.workspaceMembers.workspaceId, workspaceId));
  const brands = await db.select().from(s.brands).where(eq(s.brands.workspaceId, workspaceId));
  const ids = brands.map((b) => b.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one helper over many tables with a brand_id column
  const byBrand = async (table: any, col: any): Promise<Record<string, unknown>[]> =>
    ids.length ? ((await db.select().from(table).where(inArray(col, ids))) as Record<string, unknown>[]).map((r) => stripSecrets(r)) : [];

  const [assets, profiles, memories, strategies, revisions, tasks, campaigns, creatives, posts, accounts, competitors, assistant, runs] = await Promise.all([
    byBrand(s.brandAssets, s.brandAssets.brandId),
    byBrand(s.brandProfiles, s.brandProfiles.brandId),
    byBrand(s.brandMemories, s.brandMemories.brandId),
    byBrand(s.strategies, s.strategies.brandId),
    byBrand(s.strategyRevisions, s.strategyRevisions.brandId),
    byBrand(s.aiTasks, s.aiTasks.brandId),
    byBrand(s.campaigns, s.campaigns.brandId),
    byBrand(s.creatives, s.creatives.brandId),
    byBrand(s.posts, s.posts.brandId),
    byBrand(s.socialAccounts, s.socialAccounts.brandId),
    byBrand(s.competitors, s.competitors.brandId),
    byBrand(s.assistantMessages, s.assistantMessages.brandId),
    byBrand(s.agentRuns, s.agentRuns.brandId),
  ]);
  const postIds = posts.map((p) => String(p.id));
  const accountIds = accounts.map((a) => String(a.id));
  const [postMetrics, accountMetrics, usage, creditLimits, usageAlerts] = await Promise.all([
    postIds.length ? db.select().from(s.postMetrics).where(inArray(s.postMetrics.postId, postIds)) : [],
    accountIds.length ? db.select().from(s.accountMetrics).where(inArray(s.accountMetrics.socialAccountId, accountIds)) : [],
    db.select().from(s.usageEvents).where(eq(s.usageEvents.workspaceId, workspaceId)),
    db.select().from(s.creditLimits).where(eq(s.creditLimits.workspaceId, workspaceId)),
    db.select().from(s.usageAlerts).where(eq(s.usageAlerts.workspaceId, workspaceId)),
  ]);

  // Files: uploaded brand assets and AI-generated creative images (slides included).
  const paths = new Set<string>();
  for (const a of assets) if (typeof a.path === "string") paths.add(a.path);
  for (const c of creatives) {
    if (typeof c.imagePath === "string") paths.add(c.imagePath);
    for (const sl of (Array.isArray(c.slides) ? c.slides : []) as { imagePath?: string | null }[]) if (sl?.imagePath) paths.add(sl.imagePath);
  }
  const zip = new JSZip();
  const files: { path: string; bytes?: number; skipped?: "missing" | "over_budget" }[] = [];
  let total = 0;
  for (const p of [...paths].sort()) {
    try {
      const buf = await storage.get(p);
      if (total + buf.length > budget) {
        files.push({ path: p, skipped: "over_budget" });
        continue;
      }
      total += buf.length;
      zip.file(`files/${p}`, buf);
      files.push({ path: p, bytes: buf.length });
    } catch {
      files.push({ path: p, skipped: "missing" });
    }
  }

  const data = {
    format: "brandpilot-organisation-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    organisation: stripSecrets({ id: ws.id, name: ws.name, type: ws.type, plan: ws.plan, subscriptionStatus: ws.subscriptionStatus, currentPeriodEnd: ws.currentPeriodEnd, createdAt: ws.createdAt }),
    members,
    brands: brands.map((b) => stripSecrets(b)),
    brandAssets: assets,
    brandProfiles: profiles,
    brandMemories: memories,
    strategies,
    strategyRevisions: revisions,
    aiTasks: tasks,
    campaigns,
    creatives,
    posts,
    postMetrics: postMetrics.map((r) => stripSecrets(r)),
    socialAccounts: accounts,
    accountMetrics: accountMetrics.map((r) => stripSecrets(r)),
    competitors,
    assistantMessages: assistant,
    agentRuns: runs,
    aiUsage: usage.map((r) => stripSecrets(r)),
    creditLimits: creditLimits.map((r) => stripSecrets(r)),
    creditAlerts: usageAlerts.map((r) => stripSecrets(r)),
    files,
  };
  zip.file("data.json", JSON.stringify(data, null, 2));
  zip.file(
    "README.txt",
    [
      `BrandPilot export of "${ws.name}", ${data.exportedAt}.`,
      "",
      "data.json  the organisation, its members and every brand's data.",
      "files/     uploaded brand assets and AI-generated images, at the paths data.json refers to.",
      "",
      "Not included: passwords, two-step verification secrets, sessions, social-account access tokens,",
      "search embeddings and the AI prompts and raw responses behind each step (their results are included).",
      "The Security log has its own export: Settings → Security log → CSV or JSON.",
      "Finished creatives are rendered on demand: download them from the Creative Studio.",
      files.some((f) => f.skipped === "over_budget") ? `Some files weren't bundled to keep the archive under ${Math.round(budget / 1024 / 1024)} MB: they're listed in data.json under "files" with skipped: "over_budget".` : "",
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n"),
  );
  const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
  const counts = { brands: brands.length, posts: posts.length, creatives: creatives.length, files: files.filter((f) => f.bytes !== undefined).length, skipped: files.filter((f) => f.skipped).length };
  await audit({ action: "workspace.export", workspaceId, actorUserId, targetType: "workspace", targetId: workspaceId, details: { status: `${counts.brands} brands, ${counts.posts} posts, ${counts.creatives} creatives, ${counts.files} files${counts.skipped ? `, ${counts.skipped} skipped` : ""}` } });
  log.info("workspace.export", { workspaceId, bytes: body.length, ...counts });
  const slug = ws.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "organisation";
  return { filename: `brandpilot-${slug}-${new Date().toISOString().slice(0, 10)}.zip`, body, counts };
}
