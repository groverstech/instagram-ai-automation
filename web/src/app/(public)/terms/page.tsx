import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { loadLegalDoc } from "@/server/legal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Terms of service · BrandPilot" };

export default function Page() {
  return <LegalPage doc={loadLegalDoc("terms")} />;
}
