"use server";
import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { AccessError } from "@/server/auth/guard";
import { getSession } from "@/server/auth/session";
import { setCreditCapFor } from "@/server/credit-caps";

/** Set (a whole number) or clear (null) the organisation's monthly credit cap, or a brand's. */
export async function setCreditCap(workspaceId: string, brandId: string | null, credits: number | null) {
  return safe(async () => {
    const session = await getSession();
    if (!session) throw new AccessError("Not signed in.");
    await setCreditCapFor(session, workspaceId, brandId, credits);
    revalidatePath("/settings");
  });
}
