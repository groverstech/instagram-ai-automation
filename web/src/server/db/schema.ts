import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  real,
  vector,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const EMBEDDING_DIMS = 256;

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  // Multi-factor authentication (F3, src/server/auth/mfa.ts). Secrets are encrypted at rest; recovery
  // codes are stored only as keyed hashes.
  mfaSecretEnc: text("mfa_secret_enc"),
  /** Set during enrolment until the first code confirms the authenticator app. */
  mfaPendingSecretEnc: text("mfa_pending_secret_enc"),
  mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
  /** The last TOTP step accepted: a code can't be used twice. */
  mfaLastStep: integer("mfa_last_step"),
  mfaRecoveryHashes: jsonb("mfa_recovery_hashes").$type<string[]>().notNull().default([]),
  /** When the user proved they receive mail at `email` (auth/verify-email.ts). */
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeBrandId: text("active_brand_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** When the second factor was verified. While the user has MFA on and this is null, the session can only complete sign-in. */
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  type: text("type").$type<"creator" | "business" | "agency">().notNull().default("business"),
  plan: text("plan").$type<"starter" | "growth" | "agency">().notNull().default("starter"),
  // Billing state is written only from verified Stripe webhooks, never from client redirects.
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: createdAt(),
});

/** Processed Stripe webhook event ids, for idempotency (Stripe retries and may redeliver). */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Role = "owner" | "admin" | "editor" | "viewer";

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email"),
    role: text("role").$type<Role>().notNull().default("editor"),
    status: text("status").$type<"active" | "invited">().notNull().default("active"),
    /**
     * Brand scope for client users: null = every brand in the workspace; otherwise only these
     * brand ids. Enforced in requireBrandForUser / listAccessibleBrands.
     */
    brandIds: jsonb("brand_ids").$type<string[] | null>(),
    /** Pending invitations (members.ts): a single-use link, stored only as a SHA-256, with an expiry. */
    inviteTokenHash: text("invite_token_hash").unique(),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    invitedBy: text("invited_by"),
    createdAt: createdAt(),
  },
  (t) => [index("wm_user_idx").on(t.userId), index("wm_ws_idx").on(t.workspaceId)],
);

export const brands = pgTable(
  "brands",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    description: text("description"),
    industry: text("industry"),
    category: text("category"),
    products: text("products"),
    targetAudience: text("target_audience"),
    geography: text("geography"),
    positioning: text("positioning"),
    personality: text("personality"),
    tone: text("tone"),
    objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
    platforms: jsonb("platforms").$type<string[]>().notNull().default([]),
    competitors: jsonb("competitors").$type<string[]>().notNull().default([]),
    marketingGoals: text("marketing_goals"),
    colors: jsonb("colors").$type<string[]>().notNull().default([]),
    fonts: jsonb("fonts").$type<{ heading?: string; body?: string }>().notNull().default({}),
    onboardingComplete: boolean("onboarding_complete").notNull().default(false),
    /** Emergency pause: while set, nothing is published or scheduled for this brand (publishing-pause.ts). */
    publishingPausedAt: timestamp("publishing_paused_at", { withTimezone: true }),
    publishingPausedBy: text("publishing_paused_by"),
    publishingPauseReason: text("publishing_pause_reason"),
    /**
     * Autonomy (docs/plan/06-autonomous-publishing-security.md; src/server/autonomy): advisor,
     * assisted (default) or autonomous. Rules are versioned; every decision records the version.
     * Autonomous is suspended automatically (falls back to assisted) on token errors or failures.
     */
    autonomyLevel: text("autonomy_level").notNull().default("assisted"),
    autonomyRules: jsonb("autonomy_rules").$type<Record<string, unknown>>().notNull().default({}),
    autonomyRulesVersion: integer("autonomy_rules_version").notNull().default(1),
    autonomySuspendedAt: timestamp("autonomy_suspended_at", { withTimezone: true }),
    autonomySuspendedReason: text("autonomy_suspended_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("brands_ws_idx").on(t.workspaceId)],
);

export type AssetKind = "logo" | "guideline" | "product" | "creative" | "reference" | "post" | "presentation" | "document";
export type AssetStatus = "pending" | "approved" | "rejected";

export const brandAssets = pgTable(
  "brand_assets",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AssetKind>().notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    analysis: jsonb("analysis").$type<Record<string, unknown> | null>(),
    analysisError: text("analysis_error"),
    /** Text extracted from documents/presentations/SVG, used for analysis. */
    extractedText: text("extracted_text"),
    /** Approved assets are part of the brand's reference set used by every agent. */
    status: text("status").$type<AssetStatus>().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("assets_brand_idx").on(t.brandId)],
);

export const brandProfiles = pgTable(
  "brand_profiles",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<"draft" | "approved" | "superseded">().notNull().default("draft"),
    /** 1 = original flat profile; 2 = sectioned profile with provenance (see agents/profile.ts). */
    schemaVersion: integer("schema_version").notNull().default(1),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    /** Per-section review state: { identity: "confirmed" | "needs_review", ... } */
    sectionStatus: jsonb("section_status").$type<Record<string, "confirmed" | "needs_review">>().notNull().default({}),
    runId: text("run_id"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("profile_brand_version").on(t.brandId, t.version)],
);

export type MemoryKind = "fact" | "preference" | "feedback" | "approval" | "insight" | "competitor" | "instruction";

export const brandMemories = pgTable(
  "brand_memories",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MemoryKind>().notNull(),
    content: text("content").notNull(),
    source: text("source").notNull(),
    weight: real("weight").notNull().default(1),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    createdAt: createdAt(),
  },
  (t) => [index("memories_brand_idx").on(t.brandId)],
);

export type StrategyStatus = "draft" | "under_review" | "approved" | "archived";

/**
 * One row per strategy version. schemaVersion 1 rows are legacy monthly strategies; v2 rows hold
 * the sectioned AI Marketing Strategist document (see src/lib/strategy.ts).
 */
export const strategies = pgTable(
  "strategies",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    status: text("status").$type<StrategyStatus>().notNull().default("draft"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    runId: text("run_id"),
    schemaVersion: integer("schema_version").notNull().default(1),
    /** Per-brand version number (1, 2, 3…). */
    version: integer("version").notNull().default(1),
    title: text("title"),
    accountType: text("account_type").$type<"business" | "influencer" | "agency">(),
    /** Optimistic-concurrency counter; bumped on every write. */
    rev: integer("rev").notNull().default(0),
    parentId: text("parent_id"),
    revisionNote: text("revision_note"),
    createdBy: text("created_by"),
    submittedBy: text("submitted_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("strategies_brand_idx").on(t.brandId, t.createdAt)],
);

/** Append-only change history for a strategy version: every AI generation, user edit and restore. */
export const strategyRevisions = pgTable(
  "strategy_revisions",
  {
    id: id(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    rev: integer("rev").notNull(),
    source: text("source").$type<"ai" | "user" | "restore" | "status">().notNull(),
    action: text("action").notNull(),
    sections: jsonb("sections").$type<string[]>().notNull().default([]),
    note: text("note"),
    actorId: text("actor_id"),
    /** Full document snapshot after the change (restorable). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("strev_strategy_idx").on(t.strategyId, t.rev)],
);

export type AiTaskStep = { id: string; label: string; status: "pending" | "running" | "done" | "failed" | "skipped"; error?: string; startedAt?: string; finishedAt?: string };

/** Long-running AI work (strategy workflows, research) tracked for progress, cost and failures. */
export const aiTasks = pgTable(
  "ai_tasks",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    strategyId: text("strategy_id"),
    status: text("status").$type<"queued" | "running" | "succeeded" | "failed">().notNull().default("queued"),
    steps: jsonb("steps").$type<AiTaskStep[]>().notNull().default([]),
    /** Persistent job state: each claim increments attempts; a task is retried up to maxAttempts. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Random token of the worker that currently owns the task; writes check it. */
    claimToken: text("claim_token"),
    /** Not claimable before this time (retry backoff). */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("ai_tasks_brand_idx").on(t.brandId, t.createdAt), index("ai_tasks_strategy_idx").on(t.strategyId), index("ai_tasks_due_idx").on(t.status, t.runAfter)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(), // launch | promotion | awareness | seasonal | engagement | other
    objective: text("objective").notNull(),
    status: text("status").$type<"planning" | "active" | "completed" | "paused">().notNull().default("planning"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    brief: jsonb("brief").$type<Record<string, unknown>>().notNull().default({}),
    runId: text("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("campaigns_brand_idx").on(t.brandId)],
);

export type CreativeSlide = { headline: string; body: string; imagePrompt?: string; imagePath?: string | null; imageError?: string | null };
export type VisualSource = "ai" | "brand_photo" | "typographic";
export type LogoPlacement = "top_left" | "top_right" | "bottom_left" | "bottom_right" | "none";

export const creatives = pgTable(
  "creatives",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    parentId: text("parent_id"),
    format: text("format").notNull(),
    style: text("style").notNull(),
    concept: jsonb("concept").$type<Record<string, unknown>>().notNull(),
    imagePath: text("image_path"),
    imageProvider: text("image_provider"),
    imageError: text("image_error"),
    status: text("status").$type<"draft" | "approved" | "rejected">().notNull().default("draft"),
    runId: text("run_id"),
    /** single | carousel. Carousel slides after the cover live in `slides`. */
    kind: text("kind").$type<"single" | "carousel">().notNull().default("single"),
    slides: jsonb("slides").$type<CreativeSlide[]>().notNull().default([]),
    /** Copy pack (captions, hooks, CTA, hashtags…) written for this creative. */
    copy: jsonb("copy").$type<Record<string, unknown> | null>(),
    /** Brand consistency check: deterministic checks + vision review. */
    brandCheck: jsonb("brand_check").$type<Record<string, unknown> | null>(),
    visualSource: text("visual_source").$type<VisualSource>().notNull().default("ai"),
    /** Approved brand asset used as the visual when visualSource = brand_photo. */
    sourceAssetId: text("source_asset_id"),
    logoPlacement: text("logo_placement").$type<LogoPlacement>().notNull().default("top_left"),
    /** Produced from an approved strategy (calendar entry or campaign concept). */
    strategyId: text("strategy_id"),
    calendarEntryId: text("calendar_entry_id"),
    /** The creative_batch job that created it (idempotent recovery). */
    taskId: text("task_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("creatives_brand_idx").on(t.brandId), index("creatives_task_idx").on(t.taskId), index("creatives_strategy_idx").on(t.strategyId, t.calendarEntryId)],
);

export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";

export const posts = pgTable(
  "posts",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    creativeId: text("creative_id").references(() => creatives.id, { onDelete: "set null" }),
    socialAccountId: text("social_account_id"),
    platform: text("platform").notNull(),
    format: text("format").notNull().default("instagram_post"),
    pillar: text("pillar"),
    objective: text("objective"),
    title: text("title"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status").$type<PostStatus>().notNull().default("draft"),
    caption: text("caption"),
    copy: jsonb("copy").$type<Record<string, unknown>>().notNull().default({}),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    rationale: text("rationale"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    publishError: text("publish_error"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** "ai": created by an AI planner (eligible for autonomous approval); "human" otherwise. */
    origin: text("origin").notNull().default("human"),
    /** Set when the autonomy policy approved the post instead of a person: the rules version used. */
    autoApprovedVersion: integer("auto_approved_version"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("posts_brand_sched_idx").on(t.brandId, t.scheduledAt)],
);

export type AccountHealth = { status?: "ok" | "needs_reconnect"; reason?: string; at?: string };

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    handle: text("handle"),
    avatarUrl: text("avatar_url"),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    status: text("status").$type<"active" | "expired" | "revoked" | "error">().notNull().default("active"),
    /** Autonomy held below the brand's level for this account (null: follow the brand; never higher). */
    autonomyLevel: text("autonomy_level"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    connectedBy: text("connected_by"),
    /**
     * The platform's ID for the person who connected the account (Meta: the app-scoped user ID).
     * Meta's data-deletion and deauthorise callbacks identify people by it. Null for accounts
     * connected before migration 0011 until they're reconnected.
     */
    platformUserId: text("platform_user_id"),
    /** Set when the platform tells us the person removed the app (deauthorise callback). */
    deauthorizedAt: timestamp("deauthorized_at", { withTimezone: true }),
    /**
     * Token health (PR 4.4a): set when the platform rejects the token (expired, revoked, password
     * changed) or it expires, so the account shows "Reconnect" and publishing fails fast instead of
     * at the scheduled time. Cleared when the account is reconnected.
     */
    health: jsonb("health").$type<AccountHealth>().notNull().default({}),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("acct_brand_platform_ext").on(t.brandId, t.platform, t.externalId), index("acct_platform_user").on(t.platform, t.platformUserId)],
);

/**
 * Data-deletion requests received from a platform (Meta's data-deletion callback). The
 * confirmation code is what the person can use on the public status page; nothing else about them
 * is shown there.
 */
export const dataDeletionRequests = pgTable("data_deletion_requests", {
  id: id(),
  platform: text("platform").notNull(),
  externalUserId: text("external_user_id").notNull(),
  confirmationCode: text("confirmation_code").notNull().unique(),
  status: text("status").$type<"received" | "completed" | "failed">().notNull().default("received"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Counts only (accounts, posts detached, metrics removed); never personal data. */
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
});

export type MetricSource = "platform" | "estimate";

export const postMetrics = pgTable(
  "post_metrics",
  {
    id: id(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    reach: integer("reach"),
    impressions: integer("impressions"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    videoViews: integer("video_views"),
    linkClicks: integer("link_clicks"),
    engagementRate: real("engagement_rate"),
    source: text("source").$type<MetricSource>().notNull(),
  },
  (t) => [index("pm_post_idx").on(t.postId)],
);

export const accountMetrics = pgTable(
  "account_metrics",
  {
    id: id(),
    socialAccountId: text("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD
    followers: integer("followers"),
    profileVisits: integer("profile_visits"),
    reach: integer("reach"),
    impressions: integer("impressions"),
    source: text("source").$type<MetricSource>().notNull().default("platform"),
  },
  (t) => [uniqueIndex("am_acct_date").on(t.socialAccountId, t.date)],
);

export const competitors = pgTable(
  "competitors",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url"),
    handles: jsonb("handles").$type<string[]>().notNull().default([]),
    analysis: jsonb("analysis").$type<Record<string, unknown> | null>(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("competitors_brand_idx").on(t.brandId)],
);

export type AuditOutcome = "success" | "denied" | "failure";
/**
 * Append-only security audit log (ADR-006). Records who did what to which tenant resource, from
 * where (hashed IP), and whether it succeeded. Never stores secrets, tokens or message bodies.
 * Rows are kept when users or brands are deleted (no FK cascade), so the trail survives.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    workspaceId: text("workspace_id"),
    brandId: text("brand_id"),
    actorUserId: text("actor_user_id"),
    actorType: text("actor_type").$type<"user" | "system" | "agent">().notNull().default("user"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome").$type<AuditOutcome>().notNull().default("success"),
    ipHash: text("ip_hash"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_time_idx").on(t.workspaceId, t.createdAt), index("audit_brand_time_idx").on(t.brandId, t.createdAt), index("audit_actor_time_idx").on(t.actorUserId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    brandId: text("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    /** Organisation the run belongs to (backfilled from the brand), for organisation-level usage. */
    workspaceId: text("workspace_id"),
    parentId: text("parent_id"),
    /** The ai_tasks row this call ran for (strategist workflows); task totals are summed from here. */
    taskId: text("task_id"),
    agent: text("agent").notNull(),
    task: text("task").notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull().default("running"),
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    error: text("error"),
    provider: text("provider"),
    usage: jsonb("usage").$type<{ inputTokens?: number; outputTokens?: number; webSearches?: number; unknownUsageAttempts?: number }>(),
    model: text("model"),
    costUsd: real("cost_usd"),
    attempts: integer("attempts"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_brand_idx").on(t.brandId, t.startedAt), index("runs_task_idx").on(t.taskId), index("runs_ws_idx").on(t.workspaceId, t.startedAt)],
);

/**
 * AI usage ledger (docs/AI_PROVIDERS.md): one row per provider attempt, written whatever the
 * outcome. Append-only; rows survive brand and run deletion (no foreign keys), like the audit log.
 *   outcome: success · failed (the provider answered with an error) · retried (failed, then
 *   retried) · refused (the provider declined; billed) · unknown (sent, no response: the
 *   provider may have processed and billed it) · blocked (not sent: circuit open, not configured)
 */
/**
 * `pending`: written (durably) before a paid request is sent, holding its worst-case reserve; settled
 * in place to the final outcome. A row still pending after its process died counts at its reserve.
 */
export type UsageOutcome = "pending" | "success" | "failed" | "retried" | "refused" | "unknown" | "blocked";
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    workspaceId: text("workspace_id"),
    brandId: text("brand_id"),
    userId: text("user_id"),
    taskId: text("task_id"),
    runId: text("run_id"),
    route: text("route").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    kind: text("kind").$type<"text" | "research" | "image">().notNull(),
    attempt: integer("attempt").notNull().default(1),
    outcome: text("outcome").$type<UsageOutcome>().notNull(),
    /** Error class when not successful (auth, rate_limit, overloaded, timeout, network, ...). */
    errorKind: text("error_kind"),
    httpStatus: integer("http_status"),
    /** Units as reported by the provider: tokens (input, output, cache), web searches, images. */
    units: jsonb("units").$type<Record<string, number>>().notNull().default({}),
    /** Request parameters that drive cost: image quality, resolution, complexity; text effort. */
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    /**
     * **Estimated** cost in USD from the reported units and the rates in effect; null when the
     * units can't be priced (see priceSource). Provider-confirmed amounts live in `ai_billing`.
     */
    costUsd: real("cost_usd"),
    /** Where the price came from: provider list (dated), configuration, or "unpriced". */
    priceSource: text("price_source"),
    providerRequestId: text("provider_request_id"),
    latencyMs: integer("latency_ms"),
    /**
     * Worst-case cost reserved under the spending cap before the request was sent (spend-cap.ts).
     * Counts against the cap while the row is pending, or when the outcome is unknown or unpriced.
     */
    reserveUsd: real("reserve_usd"),
    /** When the attempt was settled (null while pending). */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_time_idx").on(t.createdAt),
    index("usage_ws_time_idx").on(t.workspaceId, t.createdAt),
    index("usage_brand_time_idx").on(t.brandId, t.createdAt),
    index("usage_run_idx").on(t.runId),
  ],
);

/**
 * Per-model rates (pricing.ts) that override the catalog's list prices without a code change: a
 * negotiated contract or a list-price change. The latest row with effective_from <= now applies.
 * `rates` are USD per million tokens (text models: input, output, cacheRead, cacheWrite5m,
 * cacheWrite1h, webSearchPer1k; image models: textInput, textCachedInput, imageInput,
 * imageCachedInput, imageOutput).
 */
export const aiPrices = pgTable(
  "ai_prices",
  {
    id: id(),
    provider: text("provider").$type<"anthropic" | "openai">().notNull(),
    model: text("model").notNull(),
    rates: jsonb("rates").$type<Record<string, number>>().notNull(),
    /** Where the rates come from, e.g. "openai-list-2026-12-01" or "contract-2027". */
    source: text("source").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_prices_model_from").on(t.model, t.effectiveFrom)],
);

/**
 * Provider-**confirmed** billing (billing.ts), imported by an operator from the providers' cost
 * reports or invoices. Platform-level: providers bill the BrandPilot account as a whole, so these
 * amounts are compared with the ledger's estimates for all organisations together and are never
 * shown to a customer organisation.
 */
export const aiBilling = pgTable(
  "ai_billing",
  {
    id: id(),
    provider: text("provider").$type<"anthropic" | "openai">().notNull(),
    /** Model the line is for; "" for a provider-wide amount. */
    model: text("model").notNull().default(""),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    confirmedUsd: real("confirmed_usd").notNull(),
    /** e.g. "openai-costs-report", "anthropic-cost-report", "invoice". */
    source: text("source").notNull(),
    reference: text("reference"),
    importedBy: text("imported_by"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_billing_line").on(t.provider, t.model, t.periodStart, t.periodEnd, t.source)],
);

/**
 * Route overrides (routes.ts): pick a different model or parameters for one AI job, globally
 * (scope_id ""), for a plan, or for a brand. Validated against the model catalog when applied.
 */
export const aiRoutes = pgTable(
  "ai_routes",
  {
    id: id(),
    key: text("key").notNull(),
    scopeType: text("scope_type").$type<"global" | "plan" | "brand">().notNull(),
    scopeId: text("scope_id").notNull().default(""),
    model: text("model"),
    params: jsonb("params").$type<{ effort?: "low" | "medium" | "high" | "xhigh" | "max"; quality?: "low" | "medium" | "high" | "xhigh" | "max"; complexity?: "low" | "medium" | "high"; timeoutMs?: number; maxAttempts?: number }>(),
    active: boolean("active").notNull().default(true),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_routes_scope_key").on(t.key, t.scopeType, t.scopeId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAt)],
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    /** "workflow" = action assistant; "brand" = Brand Q&A assistant; "strategy" = Marketing Advisor */
    channel: text("channel").$type<"workflow" | "brand" | "strategy">().notNull().default("workflow"),
    content: text("content").notNull(),
    actions: jsonb("actions").$type<{ label: string; href: string }[]>().notNull().default([]),
    /** Brand Q&A metadata: sections used, whether the answer is grounded, missing info. */
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("am_brand_idx").on(t.brandId, t.createdAt)],
);

export type Brand = typeof brands.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Creative = typeof creatives.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type StrategyRow = typeof strategies.$inferSelect;
export type AiTask = typeof aiTasks.$inferSelect;

/** Fixed-window rate-limit counters, shared by all app instances (see src/server/ratelimit.ts). */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rlb_window_idx").on(t.windowStart)],
);

/** Leases for running AI tasks, to cap concurrency per user and per organisation. */
export const aiTaskLeases = pgTable(
  "ai_task_leases",
  {
    id: id(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("leases_ws_idx").on(t.workspaceId, t.expiresAt), index("leases_user_idx").on(t.userId, t.expiresAt)],
);

/**
 * One row (`key = 'ledger'`), written by the migration that created it: when this database started
 * keeping the AI usage ledger. Spending before that time isn't recorded here, so a spending cap
 * can't cover it (paid-run-guard.ts refuses an AI_SPEND_CAP_SINCE earlier than this).
 */
export const aiLedgerMeta = pgTable("ai_ledger_meta", {
  key: text("key").primaryKey(),
  createdAt: createdAt(),
});

/**
 * Plans as configuration (PR 4.5, plan defect D5): limits, display price and included monthly
 * credits. Seeded from the values that used to be hardcoded in src/lib/plans.ts. The plan keys
 * stay fixed (starter, growth, agency) because Stripe prices map to them (billing.ts) until PR 4.6.
 * Changed with `npm run credits -- plan ...`; every change is audited.
 */
export type PlanLimits = { brands: number; seats: number; socialAccounts: number; aiRunsPerMonth: number };
export const plans = pgTable("plans", {
  key: text("key").$type<"starter" | "growth" | "agency">().primaryKey(),
  name: text("name").notNull(),
  /** Shown on the plan picker; what Stripe charges is the price object, not this. */
  priceMonthlyUsd: real("price_monthly_usd").notNull(),
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  /** Credits included each month; null until the owner sets the allowance (no cap is assumed). */
  includedCredits: integer("included_credits"),
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Credit configuration (one row, id "default"): what a credit is worth in provider cost, whether
 * failed and retried attempts are charged, and the alert thresholds.
 */
export const creditSettings = pgTable("credit_settings", {
  id: text("id").primaryKey(),
  creditValueUsd: real("credit_value_usd").notNull(),
  chargeFailedAttempts: boolean("charge_failed_attempts").notNull().default(false),
  alertThresholds: jsonb("alert_thresholds").$type<number[]>().notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Monthly credit caps set by an organisation's owners and admins: brand_id "" is the organisation. */
export const creditLimits = pgTable(
  "credit_limits",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    brandId: text("brand_id").notNull().default(""),
    monthlyCapCredits: integer("monthly_cap_credits").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credit_limits_scope").on(t.workspaceId, t.brandId)],
);

/** Each threshold alert once per period and scope (brand_id "" is the organisation). */
export const usageAlerts = pgTable(
  "usage_alerts",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    brandId: text("brand_id").notNull().default(""),
    /** "YYYY-MM" (UTC), the credit period. */
    period: text("period").notNull(),
    threshold: integer("threshold").notNull(),
    creditsUsed: real("credits_used").notNull(),
    capCredits: integer("cap_credits").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("usage_alerts_once").on(t.workspaceId, t.brandId, t.period, t.threshold)],
);

/**
 * AI kill switch (F12; src/server/ai/controls.ts). A row stops every paid AI request in its scope
 * within seconds and without a deploy: "all", "provider:<anthropic|openai>" or "model:<id>".
 * Set by an operator (`npm run ai:controls`) or by the spending tripwire; only a person clears it.
 */
export const aiControls = pgTable("ai_controls", {
  scope: text("scope").primaryKey(),
  reason: text("reason").notNull(),
  source: text("source").$type<"operator" | "tripwire">().notNull(),
  setBy: text("set_by").notNull(),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Invitation-only sign-up for the private beta (src/server/beta-invites.ts). With SIGNUP_MODE
 * invite_only (the default in staging and production), only an email on this list, or one with a
 * pending organisation invitation, can create an account. Managed by operators with
 * `npm run beta:invite`; each change is audited. Emails are stored lower-case.
 */
export const betaInvites = pgTable("beta_invites", {
  email: text("email").primaryKey(),
  invitedBy: text("invited_by").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/**
 * Password-reset tokens (account recovery, launch gate S11; src/server/auth/recovery.ts). Only a
 * SHA-256 of the token is stored. Single use, short-lived; issuing a new one voids older ones.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** "self" (forgot-password page) or "operator:<name>" (npm run users -- reset-link). */
    issuedBy: text("issued_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

/**
 * Publish-attempt ledger (PR 4.4a; docs/plan/PHASE4_PLAN.md WS3). One row per attempt to publish a
 * post, written as `sending` **before** anything is sent to the platform and settled afterwards:
 *   succeeded   the platform returned the post id
 *   failed      the platform refused it (nothing was published), or a check found it isn't there
 *   unknown     sent, but no answer (timeout, network, 5xx): it may or may not have gone out
 *   reconciled  an unknown or interrupted attempt that a check found on the platform
 * A post whose latest attempt is `sending` (interrupted) or `unknown` can't be published again until
 * a check (findRecentPost) settles it, so nothing is posted twice. No tokens are stored here.
 */
export type PublishAttemptStatus = "sending" | "succeeded" | "failed" | "unknown" | "reconciled";
export const publishAttempts = pgTable(
  "publish_attempts",
  {
    id: id(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    socialAccountId: text("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    attempt: integer("attempt").notNull(),
    /** `post:<postId>:<attempt>`: unique, so two runners can't both start the same attempt. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<PublishAttemptStatus>().notNull().default("sending"),
    /** Progress the platform reported (e.g. Instagram's container id), so a retry can resume. */
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    externalId: text("external_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("publish_attempts_post").on(t.postId, t.attempt)],
);

/**
 * Autonomy decisions and actions (docs/plan/06-autonomous-publishing-security.md §6.7). Append-only
 * by the application: every policy decision the AI acted on, and every level or rule change, with
 * the reasons and the rules version. Owners and admins can see it.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    postId: text("post_id").references(() => posts.id, { onDelete: "set null" }),
    socialAccountId: text("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
    /** "user" (a person), "agent" (the autonomy service) or "system" (automatic safeguards). */
    actorType: text("actor_type").$type<"user" | "agent" | "system">().notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    decision: text("decision").$type<"allow" | "require_approval" | "deny" | "changed">().notNull(),
    level: text("level").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    policyVersion: integer("policy_version").notNull(),
    contentHash: text("content_hash"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("agent_actions_brand").on(t.brandId, t.createdAt)],
);

/**
 * Credits added to an organisation's monthly allowance for one period (PR 4.6): top-up packs,
 * operator adjustments and plan grants. `reference` makes a grant idempotent (for example an invoice
 * or checkout id), so a webhook delivered twice grants once. Negative credits correct an error.
 */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** YYYY-MM: the month the credits apply to. */
    period: text("period").notNull(),
    credits: integer("credits").notNull(),
    kind: text("kind").$type<"topup" | "adjustment" | "plan">().notNull(),
    reference: text("reference").unique(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("credit_grants_ws_period").on(t.workspaceId, t.period)],
);

/** Email verification links (auth/verify-email.ts): single use, hashed, expiring, for one address. */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("email_verifications_user").on(t.userId)],
);
