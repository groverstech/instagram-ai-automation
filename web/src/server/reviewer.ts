import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db/client";
import { hashPassword } from "./auth/password";
import { randomToken } from "./crypto";
import { purgeWorkspace } from "./purge";

/**
 * A reviewer account for platform app reviews (PR 4.3; docs/submissions/META.md §4). Creates a user,
 * an organisation and a brand with one approved, ready-to-publish post per Meta platform and the
 * type-led creative they use, so a reviewer can connect test accounts and publish straight away.
 * Makes no AI calls. The password is returned once and only its hash is stored.
 */
export const REVIEW_BRAND = "Kora Ceramics (review)";

const CONCEPT = {
  title: "Made to last",
  headline: "Made to last",
  subline: "Small-batch stoneware for slow mornings",
  cta: "Shop the collection",
  layout: "hero_overlay",
  palette: { background: "#F3EDE4", foreground: "#2E4A3A", accent: "#B5643C" },
  imagePrompt: "",
  imageTreatment: "",
  rationale: "Reviewer demo creative (type-led, no AI image).",
};
const CAPTION = "Made to last: small-batch stoneware for slow mornings. Each piece is thrown and glazed by hand in our studio.";

export class ReviewerSetupError extends Error {}

export async function setupReviewer(input: { email: string; reset?: boolean }) {
  const email = z.string().trim().toLowerCase().email().max(200).parse(input.email);
  const db = await getDb();
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    if (!input.reset) throw new ReviewerSetupError(`${email} already exists. Run with --reset to recreate the reviewer account (this deletes its organisations).`);
    // Only organisations the reviewer alone belongs to are deleted; refuse anything shared.
    const mine = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.userId, existing.id), eq(schema.workspaceMembers.status, "active")));
    for (const m of mine) {
      const members = await db.$count(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, m.workspaceId));
      if (members > 1) throw new ReviewerSetupError(`${email} belongs to an organisation with other members; it isn't a reviewer-only account. Nothing was changed.`);
    }
    for (const m of mine) await purgeWorkspace(m.workspaceId);
    await db.delete(schema.users).where(eq(schema.users.id, existing.id));
  }

  const password = randomToken(15); // 20 characters
  const [user] = await db.insert(schema.users).values({ email, name: "App reviewer", passwordHash: await hashPassword(password) }).returning();
  const [ws] = await db.insert(schema.workspaces).values({ name: "App review", type: "business", plan: "agency" }).returning();
  await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  const [brand] = await db
    .insert(schema.brands)
    .values({
      workspaceId: ws.id,
      name: REVIEW_BRAND,
      industry: "Handmade ceramics",
      description: "A two-person studio making small-batch stoneware for everyday use.",
      products: "Stoneware mugs, serving bowls, dinner sets",
      targetAudience: "Design-conscious hosts aged 28-45",
      platforms: ["instagram", "facebook"],
      colors: ["#2E4A3A", "#F3EDE4", "#B5643C"],
      fonts: { heading: "Playfair Display", body: "Inter" },
    })
    .returning();
  const [creative] = await db.insert(schema.creatives).values({ brandId: brand.id, format: "instagram_post", style: "premium_editorial", concept: CONCEPT, visualSource: "typographic" }).returning();
  const now = new Date();
  // Shown in the Content Calendar on this date. Status stays "approved" (not scheduled): nothing
  // publishes until the reviewer chooses an account and publishes.
  const suggested = new Date(now.getTime() + 3600_000);
  const posts = await db
    .insert(schema.posts)
    .values(
      (["instagram", "facebook"] as const).map((platform) => ({
        brandId: brand.id,
        platform,
        format: "instagram_post",
        title: `Made to last (${platform === "instagram" ? "Instagram" : "Facebook"})`,
        caption: CAPTION,
        hashtags: ["stoneware", "handmade"],
        creativeId: creative.id,
        status: "approved" as const,
        scheduledAt: suggested,
        approvedAt: now,
        approvedBy: user.id,
      })),
    )
    .returning({ id: schema.posts.id, platform: schema.posts.platform });
  return { email, password, userId: user.id, workspaceId: ws.id, brandId: brand.id, creativeId: creative.id, posts };
}
