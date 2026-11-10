import "server-only";
import { log } from "./log";
import { isStrict } from "./config";

/**
 * Transactional email (ADR-007). Used next by credit alerts (PR 4.6) and invitations. The
 * provider is a pending infrastructure decision, so only the `log` driver ships now: it records
 * that an email *would* be sent (recipient domain and subject only, never the body or full
 * address) and reports `delivered: false`. It never pretends delivery happened, and in
 * staging/production it refuses so a missing provider can't go unnoticed.
 *
 *   EMAIL_PROVIDER  log (default) | <provider added when chosen>
 *   EMAIL_FROM      sender address, e.g. "BrandPilot <no-reply@yourdomain>"
 */
export type EmailMessage = { to: string; subject: string; text: string; html?: string; tag?: string };
export type EmailResult = { delivered: boolean; provider: string; id?: string };

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<EmailResult>;
}

const logDriver: EmailProvider = {
  name: "log",
  async send(msg) {
    log.info("email.not_sent", { provider: "log", toDomain: msg.to.split("@")[1] ?? "?", subject: msg.subject, tag: msg.tag });
    return { delivered: false, provider: "log" };
  },
};

export class EmailNotConfigured extends Error {}

export function emailProvider(): EmailProvider {
  const name = (process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase() || "log";
  if (name === "log") {
    if (isStrict()) throw new EmailNotConfigured("No email provider is configured (EMAIL_PROVIDER). Emails can't be sent in this environment.");
    return logDriver;
  }
  throw new EmailNotConfigured(`Unknown EMAIL_PROVIDER "${name}". The provider adapter is added when it's chosen.`);
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  return emailProvider().send(msg);
}
