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
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token)
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeBrandId: text("active_brand_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  type: text("type").$type<"creator" | "business" | "agency">().notNull().default("business"),
  plan: text("plan").$type<"starter" | "growth" | "agency">().notNull().default("starter"),
  createdAt: createdAt(),
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
    createdAt: createdAt(),
  },
  (t) => [index("brands_ws_idx").on(t.workspaceId)],
);

export type AssetKind = "logo" | "guideline" | "product" | "creative" | "reference" | "post";

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
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    runId: text("run_id"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("profile_brand_version").on(t.brandId, t.version)],
);

export type MemoryKind = "fact" | "preference" | "feedback" | "approval" | "insight" | "competitor";

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

export const strategies = pgTable("strategies", {
  id: id(),
  brandId: text("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  month: text("month").notNull(), // YYYY-MM
  status: text("status").$type<"draft" | "approved">().notNull().default("draft"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  runId: text("run_id"),
  createdAt: createdAt(),
});

export const campaigns = pgTable("campaigns", {
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
});

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
    createdAt: createdAt(),
  },
  (t) => [index("creatives_brand_idx").on(t.brandId)],
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
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("posts_brand_sched_idx").on(t.brandId, t.scheduledAt)],
);

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
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    connectedBy: text("connected_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("acct_brand_platform_ext").on(t.brandId, t.platform, t.externalId)],
);

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

export const competitors = pgTable("competitors", {
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
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    brandId: text("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    parentId: text("parent_id"),
    agent: text("agent").notNull(),
    task: text("task").notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull().default("running"),
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    error: text("error"),
    provider: text("provider"),
    usage: jsonb("usage").$type<{ inputTokens?: number; outputTokens?: number }>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_brand_idx").on(t.brandId, t.startedAt)],
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
    content: text("content").notNull(),
    actions: jsonb("actions").$type<{ label: string; href: string }[]>().notNull().default([]),
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
