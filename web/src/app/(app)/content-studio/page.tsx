import { requireActiveBrand } from "@/server/auth/guard";
import { latestStrategy } from "@/server/agents/strategy";
import { ContentStudio } from "@/components/content/studio";
import type { Strategy } from "@/server/agents/schemas";

export default async function Page() {
  const { brand, role } = await requireActiveBrand();
  const s = await latestStrategy(brand.id);
  return <ContentStudio brandId={brand.id} role={role} platforms={brand.platforms} pillars={((s?.data as Strategy | undefined)?.pillars ?? []).map((p) => p.name)} />;
}
