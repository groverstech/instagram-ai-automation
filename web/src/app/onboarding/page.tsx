import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { requireUser } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export const maxDuration = 300;

export default async function Page() {
  const s = await requireUser();
  const db = await getDb();
  // Organisations where this user may add a brand (admin or owner).
  const rows = await db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(
      and(
        eq(schema.workspaceMembers.userId, s.user.id),
        eq(schema.workspaceMembers.status, "active"),
        inArray(schema.workspaceMembers.role, ["owner", "admin"]),
      ),
    );
  if (!rows.length) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="font-display text-[30px]">You can&apos;t add a brand yet</h1>
          <p className="mt-2 text-muted">Adding brands needs the admin or owner role in an organisation. Ask an owner to change your role.</p>
          <Link href="/dashboard" className="mt-6 inline-block text-[13px] font-medium underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }
  // Default to the organisation of the brand the user is currently working in.
  let defaultId = rows[0].id;
  if (s.activeBrandId) {
    const [b] = await db.select({ ws: schema.brands.workspaceId }).from(schema.brands).where(eq(schema.brands.id, s.activeBrandId));
    if (b && rows.some((r) => r.id === b.ws)) defaultId = b.ws;
  }
  return <OnboardingWizard userName={s.user.name.split(" ")[0]} workspaces={rows} defaultWorkspaceId={defaultId} />;
}
