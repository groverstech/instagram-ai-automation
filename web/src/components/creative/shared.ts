import type { CreativeConcept } from "@/server/agents/schemas";
import type { CopyPack } from "@/server/creative/copy";
import type { BrandCheck } from "@/server/creative/brand-check";

export type VisualSourceId = "ai" | "brand_photo" | "typographic";
export type LogoPlacementId = "top_left" | "top_right" | "bottom_left" | "bottom_right" | "none";
export type StudioCreative = {
  id: string;
  format: string;
  style: string;
  status: string;
  kind: string;
  slides: { headline: string; body: string; imagePrompt?: string; hasImage: boolean }[];
  campaignId: string | null;
  parentId: string | null;
  hasImage: boolean;
  imageError: string | null;
  imageProvider: string | null;
  visualSource: string;
  sourceAssetId: string | null;
  logoPlacement: string;
  strategyId: string | null;
  calendarEntryId: string | null;
  copy: CopyPack | null;
  brandCheck: BrandCheck | null;
  createdAt: Date;
  updatedAt: Date;
  concept: CreativeConcept & { brief?: string; objective?: string | null };
};
export type StudioTask = {
  id: string;
  status: string;
  steps: { id: string; label: string; status: "pending" | "running" | "done" | "failed" | "skipped"; error?: string }[];
  error: string | null;
  costUsd: number;
  attempts?: number;
  maxAttempts?: number;
  recovering?: boolean;
  createdAt?: Date;
};
export type StudioPhoto = { id: string; name: string; kind: string };
export type ImageProviderInfo = { ready: boolean; provider: string; priced: boolean; demo?: boolean; modelLabel?: string | null; editModelLabel?: string | null };

export const LOGO_PLACEMENTS: [LogoPlacementId, string][] = [
  ["top_left", "Top left"],
  ["top_right", "Top right"],
  ["bottom_left", "Bottom left"],
  ["bottom_right", "Bottom right"],
  ["none", "Hidden"],
];

export const visualLabel = (v: string) => (v === "brand_photo" ? "Brand photo" : v === "typographic" ? "Type-led" : "AI image");
