/* eslint-disable @next/next/no-img-element -- Satori (next/og) renders plain <img>; next/image does not apply */
import "server-only";
import { ImageResponse } from "next/og";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { storage } from "../storage";
import { formatById, styleById } from "@/lib/domain";
import type { CreativeConcept } from "../agents/schemas";
import type { Brand, Creative } from "../db/schema";

type Font = { name: string; data: ArrayBuffer; weight: 400 | 600 | 700; style: "normal" };

const fontCache = new Map<string, Promise<ArrayBuffer | null>>();

/** Fetch a Google Font as WOFF (Satori can't read WOFF2). Cached per family+weight. */
function googleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  const key = `${family}:${weight}`;
  if (!fontCache.has(key)) {
    fontCache.set(
      key,
      (async () => {
        try {
          const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}`, {
            headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/534.30 (KHTML, like Gecko) Safari/534.30" },
            signal: AbortSignal.timeout(5000),
          }).then((r) => (r.ok ? r.text() : ""));
          const latin = css.split("/* latin */")[1] ?? css;
          const url = latin.match(/src:\s*url\(([^)]+)\)/)?.[1];
          if (!url) return null;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          return res.ok ? await res.arrayBuffer() : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return fontCache.get(key)!;
}

const SERIF_STYLES = new Set(["minimalist_luxury", "premium_editorial", "luxury_lifestyle", "clean_sophisticated"]);

async function loadFonts(brand: Brand, style: string): Promise<{ fonts: Font[]; heading: string; body: string }> {
  const headingFamily = brand.fonts.heading || (SERIF_STYLES.has(style) ? "Playfair Display" : style === "playful_youthful" ? "Fredoka" : "Inter");
  const bodyFamily = brand.fonts.body || "Inter";
  const [h, b, bb] = await Promise.all([googleFont(headingFamily, 600), googleFont(bodyFamily, 400), googleFont(bodyFamily, 600)]);
  const fonts: Font[] = [];
  if (h) fonts.push({ name: "Heading", data: h, weight: 600, style: "normal" });
  if (b) fonts.push({ name: "Body", data: b, weight: 400, style: "normal" });
  if (bb) fonts.push({ name: "Body", data: bb, weight: 600, style: "normal" });
  return { fonts, heading: h ? "Heading" : "sans-serif", body: b ? "Body" : "sans-serif" };
}

async function dataUri(path: string | null | undefined, mime = "image/png") {
  if (!path) return null;
  try {
    const buf = await storage.get(path);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function brandLogo(brandId: string) {
  const db = await getDb();
  const [logo] = await db
    .select()
    .from(schema.brandAssets)
    .where(and(eq(schema.brandAssets.brandId, brandId), eq(schema.brandAssets.kind, "logo")))
    .limit(1);
  if (!logo || !["image/png", "image/jpeg", "image/svg+xml", "image/webp"].includes(logo.mime)) return null;
  return dataUri(logo.path, logo.mime);
}

function hexOk(h: string | undefined, fallback: string) {
  return h && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h.trim()) ? h.trim() : fallback;
}

/** Safe-area margin as a fraction of the shorter side: logos and text stay inside it. */
export const SAFE_AREA = 72 / 1080;

export type LayoutFacts = {
  width: number;
  height: number;
  /** Text colour and what it sits on. `overImage` = on a scrim over the visual (approximate). */
  textPairs: { role: "headline" | "subline" | "cta"; color: string; background: string; overImage: boolean }[];
  logo: { placement: string; box: { x: number; y: number; w: number; h: number } | null; usesBrandLogo: boolean };
  safeArea: number;
};

/** Number of renderable slides: 1 for single creatives, cover + slides for carousels. */
export function slideCount(creative: Pick<Creative, "kind" | "slides">) {
  return creative.kind === "carousel" ? 1 + (creative.slides?.length ?? 0) : 1;
}

/** Geometry and colour facts the deterministic brand check uses (no rendering needed). */
export function layoutFacts(creative: Creative, brand: Brand, hasLogo: boolean, formatOverride?: string, slide = 0): LayoutFacts {
  const f = formatById(formatOverride ?? creative.format);
  const c = creative.concept as CreativeConcept;
  const bg = hexOk(c.palette?.background, brand.colors[1] ?? "#F4EFE8");
  const fg = hexOk(c.palette?.foreground, brand.colors[0] ?? "#1F1D1A");
  const accent = hexOk(c.palette?.accent, brand.colors[2] ?? fg);
  const unit = Math.min(f.w, f.h) / 1080;
  const pad = Math.round(72 * unit);
  const overImage = slide === 0 && (c.layout === "hero_overlay" || c.layout === "badge");
  // Text over imagery sits on a scrim of the foreground colour (~0.78 alpha); approximate the backdrop as
  // that scrim blended over a mid-grey image.
  const scrim = blend(fg, "#808080", 0.78);
  const textColor = overImage ? bg : fg;
  const textBg = overImage ? scrim : bg;
  const placement = creative.logoPlacement ?? "top_left";
  const lh = Math.round(64 * unit);
  const lw = Math.round(220 * unit);
  const box =
    placement === "none"
      ? null
      : {
          x: placement.endsWith("right") ? f.w - pad - lw : pad,
          y: placement.startsWith("bottom") ? f.h - pad - lh : pad,
          w: lw,
          h: lh,
        };
  return {
    width: f.w,
    height: f.h,
    textPairs: [
      { role: "headline", color: textColor, background: textBg, overImage },
      { role: "subline", color: textColor, background: textBg, overImage },
      ...(c.cta ? [{ role: "cta" as const, color: overImage ? contrastOn(accent) : contrastOn(accent), background: accent, overImage: false }] : []),
    ],
    logo: { placement, box, usesBrandLogo: hasLogo },
    safeArea: SAFE_AREA,
  };
}

export async function hasBrandLogo(brandId: string) {
  return Boolean(await brandLogo(brandId));
}

export async function renderCreative(creative: Creative, brand: Brand, formatOverride?: string, slide = 0): Promise<Response> {
  const f = formatById(formatOverride ?? creative.format);
  const c = creative.concept as CreativeConcept;
  const style = styleById(creative.style);
  const [{ fonts, heading, body }, image, logo] = await Promise.all([loadFonts(brand, style.id), dataUri(creative.imagePath), brandLogo(brand.id)]);

  const bg = hexOk(c.palette?.background, brand.colors[1] ?? "#F4EFE8");
  const fg = hexOk(c.palette?.foreground, brand.colors[0] ?? "#1F1D1A");
  const accent = hexOk(c.palette?.accent, brand.colors[2] ?? fg);
  const W = f.w;
  const H = f.h;
  const unit = Math.min(W, H) / 1080;
  const portrait = H > W * 1.1;
  const pad = Math.round(72 * unit);
  const headSize = Math.round((c.headline.length > 28 ? 84 : c.headline.length > 16 ? 104 : 124) * unit * (W > H * 1.4 ? 0.85 : 1));
  const tracking = style.id === "minimalist_luxury" ? "0.02em" : style.id === "bold_vibrant" ? "-0.03em" : "-0.01em";
  const upper = style.id === "bold_vibrant" || style.id === "modern_corporate";

  const placement = creative.logoPlacement ?? "top_left";
  const LogoMark = ({ color }: { color: string }) =>
    logo ? (
      <img src={logo} alt="" style={{ height: Math.round(64 * unit), objectFit: "contain" }} />
    ) : (
      <div style={{ display: "flex", fontFamily: heading, fontSize: Math.round(30 * unit), color, letterSpacing: "0.08em" }}>{brand.name.toUpperCase()}</div>
    );
  // The layouts place the logo top-left in their own flow; other placements are drawn as an overlay.
  const Logo = ({ color }: { color: string }) => (placement === "top_left" ? <LogoMark color={color} /> : <div style={{ display: "flex", height: Math.round(64 * unit) }} />);
  const LogoOverlay = () =>
    placement === "top_left" || placement === "none" ? null : (
      <div
        style={{
          position: "absolute",
          display: "flex",
          ...(placement.startsWith("top") ? { top: pad } : { bottom: pad }),
          ...(placement.endsWith("left") ? { left: pad } : { right: pad }),
          padding: `${Math.round(10 * unit)}px ${Math.round(16 * unit)}px`,
          borderRadius: Math.round(10 * unit),
          background: hexA(bg, 0.86),
        }}
      >
        <LogoMark color={fg} />
      </div>
    );

  const Cta = ({ dark }: { dark?: boolean }) =>
    c.cta ? (
      <div
        style={{
          display: "flex",
          alignSelf: "flex-start",
          padding: `${Math.round(18 * unit)}px ${Math.round(34 * unit)}px`,
          borderRadius: style.id === "playful_youthful" ? 999 : style.id === "minimalist_luxury" ? 0 : Math.round(10 * unit),
          background: dark ? fg : accent,
          color: dark ? bg : contrastOn(accent),
          fontFamily: body,
          fontWeight: 600,
          fontSize: Math.round(28 * unit),
          letterSpacing: "0.04em",
        }}
      >
        {c.cta}
      </div>
    ) : null;

  const Text = ({ color, align = "left" }: { color: string; align?: "left" | "center" }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: Math.round(26 * unit), alignItems: align === "center" ? "center" : "flex-start", textAlign: align }}>
      <div style={{ display: "flex", fontFamily: heading, fontSize: headSize, lineHeight: 1.02, letterSpacing: tracking, color, textTransform: upper ? "uppercase" : "none" }}>
        {c.headline}
      </div>
      {c.subline ? (
        <div style={{ display: "flex", fontFamily: body, fontSize: Math.round(34 * unit), lineHeight: 1.35, color, opacity: 0.86, maxWidth: W * 0.8 }}>{c.subline}</div>
      ) : null}
    </div>
  );

  const Img = ({ style: s }: { style: Record<string, unknown> }) =>
    image ? (
      <img src={image} alt="" style={{ objectFit: "cover", ...s }} />
    ) : (
      <div style={{ display: "flex", background: `linear-gradient(135deg, ${accent} 0%, ${bg} 55%, ${fg} 140%)`, ...s }} />
    );

  let el: React.ReactElement;
  const slides = creative.kind === "carousel" ? (creative.slides ?? []) : [];
  const inner = slide > 0 ? slides[slide - 1] : undefined;
  if (inner) {
    const total = 1 + slides.length;
    const last = slide === total - 1;
    const slideImg = await dataUri(inner.imagePath ?? null);
    el = (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: W, height: H, background: bg, padding: pad * 1.2, position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Logo color={fg} />
          <div style={{ display: "flex", fontFamily: body, fontSize: Math.round(26 * unit), color: accent, letterSpacing: "0.12em" }}>
            {String(slide + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </div>
        </div>
        {slideImg ? <img src={slideImg} alt="" style={{ width: W - pad * 2.4, height: H * 0.38, objectFit: "cover", borderRadius: Math.round(12 * unit) }} /> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: Math.round(28 * unit) }}>
          <div style={{ display: "flex", width: Math.round(80 * unit), height: Math.round(6 * unit), background: accent }} />
          <div style={{ display: "flex", fontFamily: heading, fontSize: Math.round((inner.headline.length > 40 ? 64 : 84) * unit), lineHeight: 1.05, letterSpacing: tracking, color: fg }}>{inner.headline}</div>
          {inner.body ? <div style={{ display: "flex", fontFamily: body, fontSize: Math.round(34 * unit), lineHeight: 1.4, color: fg, opacity: 0.86 }}>{inner.body}</div> : null}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>{last ? <Cta /> : <div style={{ display: "flex", fontFamily: body, fontSize: Math.round(24 * unit), color: fg, opacity: 0.6 }}>Swipe →</div>}</div>
        <LogoOverlay />
      </div>
    );
    return new ImageResponse(el, { width: W, height: H, fonts: fonts.length ? fonts : undefined });
  }
  switch (c.layout) {
    case "split":
      el = (
        <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", width: W, height: H, background: bg }}>
          <Img style={{ width: portrait ? W : W * 0.55, height: portrait ? H * 0.55 : H }} />
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: pad, flex: 1 }}>
            <Logo color={fg} />
            <Text color={fg} />
            <Cta />
          </div>
        </div>
      );
      break;
    case "frame":
      el = (
        <div style={{ display: "flex", flexDirection: "column", width: W, height: H, background: bg, padding: pad, gap: Math.round(40 * unit) }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Logo color={fg} />
            <div style={{ display: "flex", width: Math.round(120 * unit), height: 2, background: accent }} />
          </div>
          <Img style={{ width: W - pad * 2, flex: 1, borderRadius: style.id === "playful_youthful" ? Math.round(48 * unit) : 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: Math.round(28 * unit) }}>
            <Text color={fg} />
            <Cta />
          </div>
        </div>
      );
      break;
    case "typographic":
      el = (
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: W, height: H, background: bg, padding: pad * 1.3 }}>
          <Logo color={fg} />
          <div style={{ display: "flex", flexDirection: "column", gap: Math.round(40 * unit) }}>
            <div style={{ display: "flex", width: Math.round(96 * unit), height: Math.round(6 * unit), background: accent }} />
            <Text color={fg} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <Cta dark />
            {image ? <img src={image} alt="" style={{ width: Math.round(260 * unit), height: Math.round(260 * unit), borderRadius: 999, objectFit: "cover" }} /> : null}
          </div>
        </div>
      );
      break;
    case "editorial_column":
      el = (
        <div style={{ display: "flex", flexDirection: portrait ? "column-reverse" : "row", width: W, height: H, background: bg }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: pad, width: portrait ? W : W * 0.42, height: portrait ? H * 0.42 : H }}>
            <div style={{ display: "flex", fontFamily: body, fontSize: Math.round(22 * unit), letterSpacing: "0.3em", color: accent, textTransform: "uppercase" }}>
              {brand.name}
            </div>
            <Text color={fg} />
            <Cta />
          </div>
          <Img style={{ flex: 1, width: portrait ? W : W * 0.58, height: portrait ? H * 0.58 : H }} />
        </div>
      );
      break;
    case "badge":
      el = (
        <div style={{ display: "flex", width: W, height: H, background: bg, position: "relative" }}>
          <Img style={{ position: "absolute", top: 0, left: 0, width: W, height: H }} />
          <div style={{ position: "absolute", top: 0, left: 0, width: W, height: H, display: "flex", background: `linear-gradient(180deg, rgba(0,0,0,0) 45%, ${hexA(fg, 0.75)} 100%)` }} />
          <div style={{ position: "absolute", top: pad, left: pad, display: "flex" }}>
            <Logo color={bg} />
          </div>
          {c.cta ? (
            <div
              style={{
                position: "absolute",
                top: pad,
                right: pad,
                width: Math.round(230 * unit),
                height: Math.round(230 * unit),
                borderRadius: 999,
                background: accent,
                color: contrastOn(accent),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: Math.round(24 * unit),
                fontFamily: heading,
                fontSize: Math.round(36 * unit),
                lineHeight: 1.05,
              }}
            >
              {c.cta}
            </div>
          ) : null}
          <div style={{ position: "absolute", left: pad, right: pad, bottom: pad, display: "flex" }}>
            <Text color={bg} />
          </div>
        </div>
      );
      break;
    case "hero_overlay":
    default:
      el = (
        <div style={{ display: "flex", width: W, height: H, background: bg, position: "relative" }}>
          <Img style={{ position: "absolute", top: 0, left: 0, width: W, height: H }} />
          <div style={{ position: "absolute", top: 0, left: 0, width: W, height: H, display: "flex", background: `linear-gradient(180deg, ${hexA(fg, 0.05)} 30%, ${hexA(fg, 0.78)} 100%)` }} />
          <div style={{ position: "absolute", top: 0, left: 0, width: W, height: H, padding: pad, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <Logo color={bg} />
            <div style={{ display: "flex", flexDirection: "column", gap: Math.round(36 * unit) }}>
              <Text color={bg} />
              <Cta />
            </div>
          </div>
        </div>
      );
  }

  const framed =
    placement === "top_left" ? (
      el
    ) : (
      <div style={{ display: "flex", position: "relative", width: W, height: H }}>
        {el}
        <LogoOverlay />
      </div>
    );
  return new ImageResponse(framed, { width: W, height: H, fonts: fonts.length ? fonts : undefined });
}

export async function renderCreativePng(creative: Creative, brand: Brand, formatOverride?: string, slide = 0): Promise<Buffer> {
  const res = await renderCreative(creative, brand, formatOverride, slide);
  return Buffer.from(await res.arrayBuffer());
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function contrastOn(hex: string) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const n = parseInt(full, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#FFFFFF";
}

function blend(fgHex: string, bgHex: string, alpha: number) {
  const p = (h: string) => {
    const x = h.replace("#", "");
    const full = x.length === 3 ? x.split("").map((c) => c + c).join("") : x;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = p(fgHex);
  const b = p(bgHex);
  return "#" + a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}
