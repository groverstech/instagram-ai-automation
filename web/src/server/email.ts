import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "./log";
import { isStrict } from "./config";

/**
 * Transactional email (ADR-007; docs/EMAIL.md). One small interface, several drivers, chosen by
 * EMAIL_PROVIDER:
 *
 *   log       (development default) records that an email *would* be sent: recipient domain and
 *             subject only, never the body or the full address. Reports delivered: false.
 *   file      development and tests: writes each message as JSON to EMAIL_OUTBOX_DIR, so a local
 *             browser journey can open the link. Refused in staging and production.
 *   memory    unit tests: keeps messages in this process (memoryOutbox()). Refused in staging and production.
 *   postmark  Postmark's HTTP API (EMAIL_API_KEY = server token). Not used until the owner chooses a
 *   resend    Resend's HTTP API (EMAIL_API_KEY).                   provider (decision D-7).
 *
 * In staging and production only postmark or resend are accepted, with EMAIL_FROM and EMAIL_API_KEY;
 * anything else refuses to "send", so a missing provider can't go unnoticed. Nothing here claims a
 * delivery that didn't happen.
 */
export type EmailMessage = { to: string; subject: string; text: string; html?: string; tag?: string };
export type EmailResult = { delivered: boolean; provider: string; id?: string };

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<EmailResult>;
}

export class EmailNotConfigured extends Error {}
export class EmailSendError extends Error {}

type Env = Record<string, string | undefined>;

const logDriver: EmailProvider = {
  name: "log",
  async send(msg) {
    log.info("email.not_sent", { provider: "log", toDomain: msg.to.split("@")[1] ?? "?", subject: msg.subject, tag: msg.tag });
    return { delivered: false, provider: "log" };
  },
};

type Stored = EmailMessage & { id: string; at: string; from: string };
const g = globalThis as unknown as { __bpOutbox?: Stored[] };
/** Messages the memory driver "sent" in this process (tests). */
export function memoryOutbox(): Stored[] {
  return (g.__bpOutbox ??= []);
}

function fileDriver(dir: string, from: string): EmailProvider {
  return {
    name: "file",
    async send(msg) {
      fs.mkdirSync(dir, { recursive: true });
      const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, at: new Date().toISOString(), from, ...msg }, null, 2), { mode: 0o600 });
      return { delivered: true, provider: "file", id };
    },
  };
}

function memoryDriver(from: string): EmailProvider {
  return {
    name: "memory",
    async send(msg) {
      const id = crypto.randomUUID();
      memoryOutbox().push({ id, at: new Date().toISOString(), from, ...msg });
      return { delivered: true, provider: "memory", id };
    },
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  // Never include the request (it carries the key) or the recipient in the error.
  if (!res.ok) throw new EmailSendError(`Email provider answered ${res.status}${typeof json.Message === "string" ? `: ${json.Message}` : typeof json.message === "string" ? `: ${json.message}` : ""}`);
  return json;
}

/** Postmark (https://postmarkapp.com/developer/api/email-api). */
export function postmarkDriver(apiKey: string, from: string, stream = "outbound"): EmailProvider {
  return {
    name: "postmark",
    async send(msg) {
      const r = await post("https://api.postmarkapp.com/email", { "X-Postmark-Server-Token": apiKey }, { From: from, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, Tag: msg.tag, MessageStream: stream });
      return { delivered: true, provider: "postmark", id: typeof r.MessageID === "string" ? r.MessageID : undefined };
    },
  };
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). */
export function resendDriver(apiKey: string, from: string): EmailProvider {
  return {
    name: "resend",
    async send(msg) {
      const r = await post("https://api.resend.com/emails", { authorization: `Bearer ${apiKey}` }, { from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, tags: msg.tag ? [{ name: "category", value: msg.tag.replace(/[^\w-]/g, "_") }] : undefined });
      return { delivered: true, provider: "resend", id: typeof r.id === "string" ? r.id : undefined };
    },
  };
}

export function emailProvider(env: Env = process.env): EmailProvider {
  const name = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase() || "log";
  const strict = isStrict(env);
  const from = (env.EMAIL_FROM ?? "").trim() || "BrandPilot <no-reply@localhost>";
  if (name === "log" || name === "file" || name === "memory") {
    if (strict) throw new EmailNotConfigured(`EMAIL_PROVIDER=${name} is for development and tests. Configure postmark or resend here.`);
    if (name === "log") return logDriver;
    if (name === "memory") return memoryDriver(from);
    return fileDriver((env.EMAIL_OUTBOX_DIR ?? "").trim() || path.join(process.cwd(), ".data", "outbox"), from);
  }
  if (name === "postmark" || name === "resend") {
    const key = (env.EMAIL_API_KEY ?? "").trim();
    if (!key) throw new EmailNotConfigured(`EMAIL_PROVIDER=${name} needs EMAIL_API_KEY.`);
    if (!(env.EMAIL_FROM ?? "").trim()) throw new EmailNotConfigured("EMAIL_FROM is required, e.g. \"BrandPilot <no-reply@yourdomain>\".");
    return name === "postmark" ? postmarkDriver(key, from, (env.EMAIL_POSTMARK_STREAM ?? "").trim() || "outbound") : resendDriver(key, from);
  }
  throw new EmailNotConfigured(`Unknown EMAIL_PROVIDER "${name}". Use postmark or resend (or log, file or memory in development).`);
}

export async function sendEmail(msg: EmailMessage, env: Env = process.env): Promise<EmailResult> {
  const r = await emailProvider(env).send(msg);
  log.info("email.sent", { provider: r.provider, delivered: r.delivered, tag: msg.tag, toDomain: msg.to.split("@")[1] ?? "?" });
  return r;
}

export function appUrl(env: Env = process.env) {
  return (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
