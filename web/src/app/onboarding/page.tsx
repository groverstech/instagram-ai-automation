import { requireUser } from "@/server/auth/guard";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export const maxDuration = 300;

export default async function Page() {
  const s = await requireUser();
  return <OnboardingWizard userName={s.user.name.split(" ")[0]} />;
}
