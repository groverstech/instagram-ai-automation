import { facebook, instagram } from "./providers/meta";
import { linkedin, pinterest, tiktok, youtube } from "./providers/others";
import type { SocialProvider } from "./types";

export const PROVIDERS: Record<string, SocialProvider> = { instagram, facebook, linkedin, youtube, pinterest, tiktok };

export function provider(id: string): SocialProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown platform: ${id}`);
  return p;
}

export function providerSummaries() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, configured: p.configured(), capabilities: p.capabilities, envKeys: p.envKeys }));
}
