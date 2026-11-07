import { eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { providerSummaries } from "@/server/social/registry";
import { isPublicAppUrl, appUrl } from "@/server/social/service";
import { AccountsView } from "@/components/accounts/view";

export default async function Page({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, brand.id));
  return (
    <AccountsView
      brandId={brand.id}
      role={role}
      providers={providerSummaries()}
      publicUrl={isPublicAppUrl()}
      appUrl={appUrl()}
      connected={sp.connected}
      error={sp.error}
      accounts={accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle, avatarUrl: a.avatarUrl, status: a.status, expiresAt: a.expiresAt, createdAt: a.createdAt, boards: (a.meta.boards as { id: string; name: string }[] | undefined) ?? null, boardId: (a.meta.boardId as string | undefined) ?? null }))}
    />
  );
}
