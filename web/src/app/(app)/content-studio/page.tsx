import { requireActiveBrand } from "@/server/auth/guard";
import { latestStrategy } from "@/server/agents/strategy";
import { ContentStudio } from "@/components/content/studio";
import { summarizeStrategy } from "@/lib/strategy";

export default async function Page() {
  const { brand, role } = await requireActiveBrand();
  const s = await latestStrategy(brand.id);
  return <ContentStudio brandId={brand.id} role={role} platforms={brand.platforms} pillars={s ? summarizeStrategy(s.data, s.schemaVersion).pillars.map((p) => p.name) : []} />;
}
