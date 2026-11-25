"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { AccessError, requireBrand } from "@/server/auth/guard";
import { requireRecentSecondFactor } from "@/server/auth/step-up";
import { updateAutonomy } from "@/server/autonomy/service";

const Input = z.object({
  level: z.enum(["advisor", "assisted", "autonomous"]).optional(),
  rules: z
    .object({
      maxPerDay: z.number().int().min(0).max(10),
      maxPerWeek: z.number().int().min(0).max(50),
      minGapHours: z.number().int().min(0).max(168),
      allowedHours: z.array(z.number().int().min(0).max(23)).max(24),
      allowedDays: z.array(z.number().int().min(0).max(6)).max(7),
      warmup: z.number().int().min(0).max(50),
      allowedPillars: z.array(z.string().max(80)).max(50),
      bannedTopics: z.array(z.string().max(80)).max(200),
      linkDomains: z.array(z.string().max(120).regex(/^[a-z0-9.-]+$/i, "a domain like example.com")).max(50),
    })
    .optional(),
  accounts: z.array(z.object({ id: z.string().max(64), level: z.enum(["advisor", "assisted", "autonomous"]).nullable() })).max(50).optional(),
});

/**
 * Autonomy level and rules (docs/AUTONOMY.md): owners with access to the whole organisation only,
 * with a recent second factor (step-up); every change is audited with before and after values.
 */
export async function updateAutonomyAction(brandId: string, input: z.input<typeof Input>) {
  return safe(async () => {
    // Brand-scoped client members are editors or viewers, so an owner always covers the organisation.
    const { session, role } = await requireBrand(brandId, "owner");
    if (role !== "owner") throw new AccessError("Only organisation owners can change autonomy.");
    await requireRecentSecondFactor(session);
    const changes = await updateAutonomy(brandId, { userId: session.user.id }, Input.parse(input));
    revalidatePath("/settings");
    revalidatePath("/calendar");
    return changes;
  });
}
