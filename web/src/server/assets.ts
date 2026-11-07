import "server-only";
import JSZip from "jszip";

/**
 * Upload validation and text extraction for brand assets.
 * The file type is detected from its bytes; the browser-supplied MIME type is not trusted.
 */

export const MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  text: "text/plain",
} as const;
export type DetectedMime = (typeof MIME)[keyof typeof MIME];

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;
/** Total per request; keep below serverActions.bodySizeLimit in next.config.ts. */
export const MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UNZIPPED_ENTRY = 25 * 1024 * 1024;
const MAX_UNZIPPED_TOTAL = 150 * 1024 * 1024;
const MAX_TEXT = 20_000;

export const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.docx,.pptx,.txt,.md";

export class UploadError extends Error {}

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** Identify a file from its content. Returns null for unsupported or unrecognised files. */
export async function detectMime(buf: Buffer, name: string): Promise<DetectedMime | null> {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME.png;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return MIME.jpeg;
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return MIME.gif;
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return MIME.webp;
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return MIME.pdf;
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const zip = await JSZip.loadAsync(buf);
      if (zip.file("word/document.xml")) return MIME.docx;
      if (zip.file("ppt/presentation.xml")) return MIME.pptx;
    } catch {
      return null;
    }
    return null;
  }
  // Text-based formats: must be valid UTF-8 without NUL bytes.
  const head = buf.subarray(0, 4096);
  if (head.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (text.includes("�")) return null;
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return MIME.svg;
  if (/\.(txt|md|markdown)$/i.test(name)) return MIME.text;
  return null;
}

/** Validate one uploaded file; returns the detected type or throws a user-facing error. */
export async function validateUpload(name: string, buf: Buffer): Promise<DetectedMime> {
  if (!buf.length) throw new UploadError(`${name} is empty.`);
  if (buf.length > MAX_FILE_BYTES) throw new UploadError(`${name} is larger than 15 MB.`);
  const mime = await detectMime(buf, name);
  if (!mime) throw new UploadError(`${name}: unsupported or unrecognised file. Use PNG, JPG, WebP, GIF, SVG, PDF, DOCX, PPTX, TXT or MD.`);
  if (mime === MIME.svg && /<script|\son\w+\s*=|javascript:/i.test(buf.toString("utf8"))) {
    throw new UploadError(`${name}: SVG files with scripts or event handlers aren't allowed.`);
  }
  return mime;
}

export function extFor(mime: string) {
  return (
    {
      [MIME.png]: "png",
      [MIME.jpeg]: "jpg",
      [MIME.webp]: "webp",
      [MIME.gif]: "gif",
      [MIME.svg]: "svg",
      [MIME.pdf]: "pdf",
      [MIME.docx]: "docx",
      [MIME.pptx]: "pptx",
      [MIME.text]: "txt",
    } as Record<string, string>
  )[mime] ?? "bin";
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

const entrySize = (f: JSZip.JSZipObject) => (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;

/** Reject archives whose declared uncompressed size is unreasonable (zip bombs). */
async function openZip(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const total = Object.values(zip.files).reduce((n, f) => n + entrySize(f), 0);
  if (total > MAX_UNZIPPED_TOTAL) throw new UploadError("Document expands to an unreasonable size and can't be read.");
  return zip;
}

async function zipText(zip: JSZip, path: string) {
  const f = zip.file(path);
  if (!f) return "";
  if (entrySize(f) > MAX_UNZIPPED_ENTRY) throw new UploadError("Document is too large to read.");
  return f.async("string");
}

/** Plain text from a document/presentation/text/SVG, capped. Images and PDFs return null (sent natively). */
export async function extractText(mime: string, buf: Buffer): Promise<string | null> {
  let out: string | null = null;
  if (mime === MIME.docx) {
    const zip = await openZip(buf);
    const xml = await zipText(zip, "word/document.xml");
    out = decodeXml(
      xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    );
  } else if (mime === MIME.pptx) {
    const zip = await openZip(buf);
    const slides = Object.keys(zip.files)
      .map((p) => p.match(/^ppt\/slides\/slide(\d+)\.xml$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const parts: string[] = [];
    for (const m of slides) {
      const xml = await zipText(zip, m[0]);
      const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((r) => decodeXml(r[1]));
      if (runs.length) parts.push(`Slide ${m[1]}: ${runs.join(" ")}`);
      if (parts.reduce((n, p) => n + p.length, 0) > MAX_TEXT) break;
    }
    out = parts.join("\n");
  } else if (mime === MIME.text) {
    out = buf.toString("utf8");
  } else if (mime === MIME.svg) {
    const svg = buf.toString("utf8");
    const colors = [...new Set((svg.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? []).map((c) => c.toUpperCase()))];
    const text = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].trim()).filter(Boolean);
    out = `SVG vector graphic. Colours used: ${colors.join(", ") || "none declared"}.${text.length ? ` Text: ${text.join(" ")}` : ""}\n${svg.slice(0, 4000)}`;
  }
  if (out == null) return null;
  out = out.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return out.slice(0, MAX_TEXT);
}
