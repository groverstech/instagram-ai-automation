import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

/**
 * Public legal pages (PR 4.3): /privacy, /terms and /data-deletion, rendered from editable
 * markdown in `content/legal/`. The text is the owner's (from counsel); until a document's front
 * matter says `status: final` the page shows a draft banner and must not be submitted to a
 * platform review.
 *
 * Front matter: `title`, `status` (draft | final), `updated` (YYYY-MM-DD). Placeholders filled
 * from the environment: {{company}} (LEGAL_ENTITY_NAME), {{contact}} (LEGAL_CONTACT_EMAIL),
 * {{appUrl}} (APP_URL). A missing value shows as a visible "[to be confirmed]" marker.
 *
 * The renderer supports headings (#, ##, ###), paragraphs, bulleted and numbered lists, **bold**
 * and [links](https://…). It builds React elements, so the text can never inject HTML.
 */
export type LegalDoc = { slug: LegalSlug; title: string; status: "draft" | "final"; updated: string | null; body: ReactNode };
export const LEGAL_SLUGS = ["privacy", "terms", "data-deletion"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

const DIR = path.join(process.cwd(), "content", "legal");

function fill(text: string, env: Record<string, string | undefined>): string {
  const v = (k: string, label: string) => env[k]?.trim() || `[${label} to be confirmed]`;
  return text
    .replaceAll("{{company}}", v("LEGAL_ENTITY_NAME", "company name"))
    .replaceAll("{{contact}}", v("LEGAL_CONTACT_EMAIL", "contact email"))
    .replaceAll("{{appUrl}}", (env.APP_URL ?? "").replace(/\/$/, "") || "[website address to be confirmed]");
}

/** Inline formatting: **bold** and [text](href) with http(s), mailto or same-site hrefs only. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${key}-${n++}`}>{m[1]}</strong>);
    else {
      const href = m[3];
      const safe = /^(https?:\/\/|mailto:|\/(?!\/))/i.test(href);
      out.push(
        safe ? (
          <a key={`${key}-${n++}`} href={href} className="underline underline-offset-2" {...(/^https?:/i.test(href) ? { rel: "noopener noreferrer" } : {})}>
            {m[2]}
          </a>
        ) : (
          m[2]
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(md: string): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "font-display text-[32px] leading-tight" : level === 2 ? "mt-8 text-[19px] font-semibold" : "mt-5 text-[15px] font-semibold";
      const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
      blocks.push(
        <Tag key={k} className={cls}>
          {inline(h[2], `h${k}`)}
        </Tag>,
      );
      k++;
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      const List = (ordered ? "ol" : "ul") as "ol" | "ul";
      blocks.push(
        <List key={k} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1.5 pl-5`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `l${k}-${j}`)}</li>
          ))}
        </List>,
      );
      k++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={k}>{inline(para.join(" "), `p${k}`)}</p>);
    k++;
  }
  return blocks;
}

export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const l of m[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(l.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.replace(/\r\n/g, "\n").slice(m[0].length) };
}

export function loadLegalDoc(slug: LegalSlug, env: Record<string, string | undefined> = process.env): LegalDoc {
  const raw = fs.readFileSync(path.join(DIR, `${slug}.md`), "utf8");
  const { meta, body } = parseFrontMatter(raw);
  return {
    slug,
    title: meta.title || slug,
    status: meta.status === "final" ? "final" : "draft",
    updated: /^\d{4}-\d{2}-\d{2}$/.test(meta.updated ?? "") ? meta.updated : null,
    body: renderMarkdown(fill(body, env)),
  };
}
