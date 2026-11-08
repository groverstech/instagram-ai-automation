/**
 * Pure, deterministic quality maths for creatives and copy (shared by server and UI; no secrets).
 */

// ---------- colour ----------
export function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace("#", "");
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) return null;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance and contrast ratio (1–21). */
export function contrastRatio(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const lum = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(ra), lum(rb)].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

function rgbToLab([r, g, b]: [number, number, number]) {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 ΔE between two colours (≈ 2.3 is a just-noticeable difference). */
export function deltaE(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const [l1, a1, b1] = rgbToLab(ra);
  const [l2, a2, b2] = rgbToLab(rb);
  return Math.round(Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) * 10) / 10;
}

/** Distance from a colour to the nearest brand colour. Neutrals (near-black/near-white) are always allowed. */
export function paletteDistance(color: string, brandColors: string[]): number | null {
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  const neutral = deltaE(color, "#000000")! < 12 || deltaE(color, "#FFFFFF")! < 6;
  if (neutral) return 0;
  const ds = brandColors.map((b) => deltaE(color, b)).filter((d): d is number => d !== null);
  return ds.length ? Math.min(...ds) : null;
}

// ---------- copy originality ----------
export const CLICHES = [
  "elevate", "unlock", "game-changer", "game changer", "dive in", "in today's fast-paced world", "look no further", "seamless",
  "revolutionize", "revolutionise", "take it to the next level", "unleash", "next level", "embark on", "a testament to",
  "in the realm of", "delve", "tapestry", "whether you're", "say goodbye to", "say hello to", "we've got you covered",
];

export function findCliches(text: string): string[] {
  const t = text.toLowerCase();
  return CLICHES.filter((c) => t.includes(c));
}

function shingles(text: string, n = 3) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s#]/gu, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** Jaccard similarity of word 3-grams (0–1). Captions above ~0.45 read as near-duplicates. */
export function similarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return Math.round((inter / (A.size + B.size - inter)) * 100) / 100;
}

export const SIMILARITY_LIMIT = 0.45;
