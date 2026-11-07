import { and, eq } from "drizzle-orm";
import { requireActiveBrand, listAccessibleBrands } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { aiStatus } from "@/server/ai/llm";
import { assistantHistory } from "@/server/agents/assistant";
import { Sidebar } from "@/components/shell/sidebar";
import { Assistant } from "@/components/shell/assistant";
import { Toaster } from "@/components/ui/toast";

export const maxDuration = 300;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [brands, pending, history] = await Promise.all([
    listAccessibleBrands(session.user.id),
    db.$count(schema.posts, and(eq(schema.posts.brandId, brand.id), eq(schema.posts.status, "pending_approval"))),
    assistantHistory(brand.id, 30),
  ]);
  const ai = aiStatus();
  return (
    <div className="flex min-h-screen">
      <Sidebar
        brand={{ id: brand.id, name: brand.name, colors: brand.colors }}
        brands={brands.map((b) => ({ id: b.brand.id, name: b.brand.name }))}
        user={{ name: session.user.name, email: session.user.email, role }}
        pendingApprovals={pending}
      />
      <div className="min-w-0 flex-1">
        {!ai.ready ? (
          <div className="border-b border-warn/20 bg-warn-soft px-6 py-2 text-[12px] text-warn md:px-10">
            AI is not configured. Add <code className="font-mono">ANTHROPIC_API_KEY</code> to the server environment to enable the agents.
          </div>
        ) : ai.provider === "mock" ? (
          <div className="border-b border-line bg-sunken px-6 py-2 text-[12px] text-muted md:px-10">Mock AI provider active (AI_PROVIDER=mock). Generated content is placeholder output for development.</div>
        ) : null}
        <main className="mx-auto max-w-[1280px] px-6 py-8 md:px-10 md:py-10">{children}</main>
      </div>
      <Toaster />
      <Assistant
        brandId={brand.id}
        brandName={brand.name}
        initial={history.map((h) => ({ id: h.id, role: h.role, content: h.content, actions: h.actions }))}
        canRun={role !== "viewer"}
      />
    </div>
  );
}
