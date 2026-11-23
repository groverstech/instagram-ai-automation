/**
 * What BrandPilot can do on a platform **today** (plan defect D2: never promise more than the code does).
 *   supported            implemented, and works with standard access
 *   requires_app_review  implemented, but the platform allows it only once the app passes its review
 *   not_built            the platform offers it, but BrandPilot doesn't implement it yet
 *   unsupported          the platform's API doesn't offer it
 * `social-capabilities.test.ts` checks every claim against the provider's implemented methods.
 */
export type Capability = "supported" | "requires_app_review" | "not_built" | "unsupported";

export type Capabilities = {
  publishImage: Capability;
  publishCarousel: Capability;
  publishVideo: Capability;
  scheduleNative: Capability;
  postAnalytics: Capability;
  accountAnalytics: Capability;
  notes: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string;
  /** The platform's ID for the person who signed in (Meta: app-scoped user ID). */
  platformUserId?: string;
};

export type DiscoveredAccount = {
  platform: string;
  externalId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  /** Token to store for this specific account (e.g. a Page token), else the user token. */
  token: TokenSet;
  meta?: Record<string, unknown>;
};

export type AccountForUse = {
  id: string;
  platform: string;
  externalId: string;
  accessToken: string;
  meta: Record<string, unknown>;
};

export type PublishInput = {
  caption: string;
  title?: string;
  /** Publicly reachable URL of the rendered image (required by Instagram & Pinterest). */
  imageUrl: string;
  /** Rendered image bytes (used by platforms that take uploads, e.g. LinkedIn). */
  image: () => Promise<Buffer>;
};

export type PublishResult = { externalId: string; url?: string };

/**
 * Passed to publish() by the attempt ledger (PR 4.4a; service.ts).
 * - `resume`: progress saved by an earlier attempt of the same post (e.g. Instagram's container id),
 *   so a retry continues instead of starting over.
 * - `progress(data)`: save progress now, before the next request.
 * - `finalSend()`: call immediately before the request that makes the post public. An error before
 *   it means nothing was published; after it, a timeout or server error leaves the outcome unknown.
 */
export type PublishContext = {
  resume: Record<string, unknown>;
  progress(data: Record<string, unknown>): Promise<void>;
  finalSend(): void;
};

export type MetricsResult = {
  reach?: number | null;
  impressions?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  videoViews?: number | null;
  linkClicks?: number | null;
};

export type AccountMetricsResult = { followers?: number | null; profileVisits?: number | null; reach?: number | null; impressions?: number | null };

export interface SocialProvider {
  id: string;
  label: string;
  /** OAuth app family; Instagram and Facebook share one Meta login. */
  oauthFamily: string;
  capabilities: Capabilities;
  envKeys: string[];
  configured(): boolean;
  authorizeUrl(p: { state: string; redirectUri: string; codeChallenge: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet>;
  discoverAccounts(token: TokenSet): Promise<DiscoveredAccount[]>;
  publish?(account: AccountForUse, input: PublishInput, ctx?: PublishContext): Promise<PublishResult>;
  /**
   * Reconciliation (PR 4.4a): find a post this account published since `since` whose text is
   * `caption`. Used before retrying an attempt whose outcome is unknown, so a post never goes out
   * twice. Null when there is none.
   */
  findRecentPost?(account: AccountForUse, q: { caption: string; since: Date }): Promise<PublishResult | null>;
  postMetrics?(account: AccountForUse, externalId: string): Promise<MetricsResult>;
  accountMetrics?(account: AccountForUse): Promise<AccountMetricsResult>;
}

export class PublishNotSupported extends Error {}
export class PlatformError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** The platform's own error code, when it gives one (Meta: `error.code`, e.g. 190 = invalid token). */
    public code?: number,
  ) {
    super(message);
  }
}

/** The platform rejected the account's token: it must be reconnected (token health, PR 4.4a). */
export function isTokenError(e: unknown): boolean {
  return e instanceof PlatformError && (e.status === 401 || e.code === 190 || e.code === 102);
}
