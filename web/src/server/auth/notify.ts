import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { log } from "../log";

/**
 * Security notifications (ASVS 2.2.3): tell the account holder by email after a credential or
 * second-factor change, so a takeover doesn't go unnoticed. Never throws; no secrets in the text.
 */
const TEXT: Record<string, { subject: string; body: string }> = {
  password_reset: { subject: "Your BrandPilot password was changed", body: "The password for your BrandPilot account was just changed, and every session was signed out." },
  mfa_enabled: { subject: "Two-step verification is on", body: "Two-step verification was turned on for your BrandPilot account." },
  mfa_disabled: { subject: "Two-step verification was turned off", body: "Two-step verification was turned off for your BrandPilot account." },
  recovery_used: { subject: "A recovery code was used to sign in", body: "Someone signed in to your BrandPilot account with one of your recovery codes." },
  recovery_regenerated: { subject: "New recovery codes were created", body: "New two-step verification recovery codes were created for your BrandPilot account; the old ones no longer work." },
};

export async function notifyAccountChange(userId: string, what: keyof typeof TEXT) {
  try {
    const db = await getDb();
    const [u] = await db.select({ email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
    if (!u) return;
    const t = TEXT[what];
    const { sendEmail } = await import("../email");
    await sendEmail({
      to: u.email,
      subject: t.subject,
      text: `Hi ${u.name || "there"},\n\n${t.body} (${new Date().toUTCString()})\n\nIf this was you, there's nothing to do. If it wasn't, reset your password now and contact support: your account may be at risk.`,
      tag: `security.${what}`,
    });
  } catch (e) {
    log.warn("auth.notify_failed", { what, error: e instanceof Error ? e.message : String(e) });
  }
}
