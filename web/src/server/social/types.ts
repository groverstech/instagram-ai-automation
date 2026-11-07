export type Capability = "supported" | "unsupported" | "requires_app_review";

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
  publish?(account: AccountForUse, input: PublishInput): Promise<PublishResult>;
  postMetrics?(account: AccountForUse, externalId: string): Promise<MetricsResult>;
  accountMetrics?(account: AccountForUse): Promise<AccountMetricsResult>;
}

export class PublishNotSupported extends Error {}
export class PlatformError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
