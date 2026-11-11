import { and, eq } from "drizzle-orm";
import { requireActiveBrand, listAccessibleBrands } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { aiStatus } from "@/server/ai/llm";
import { imageModelLabel, imageStatus } from "@/server/ai/image";
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
  const img = imageStatus();
  return (
    <div className="flex min-h-screen">
      <Sidebar
        brand={{ id: brand.id, name: brand.name, colors: brand.colors }}
        brands={brands.map((b) => ({ id: b.brand.id, name: b.brand.name }))}
        user={{ name: session.user.name, email: session.user.email, role }}
        pendingApprovals={pending}
      />
      <div className="min-w-0 flex-1 pt-[calc(3.5rem+env(safe-area-inset-top))] md:pt-0">
        {!ai.ready ? (
          <div className="border-b border-warn/20 bg-warn-soft px-6 py-2 text-[12px] text-warn md:px-10">
            AI is not configured. Add <code className="font-mono">ANTHROPIC_API_KEY</code> to the server environment to enable the agents.
          </div>
        ) : ai.provider === "mock" ? (
          <div role="status" aria-label="AI mode: demo" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn/20 bg-warn-soft px-6 py-2 text-[12px] text-warn md:px-10">
            <span className="rounded-full bg-warn px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">Demo mode</span>
            <span>No AI provider is called. Text and images are labelled placeholders, nothing is billed (AI_PROVIDER=mock).</span>
          </div>
        ) : (
          <div role="status" aria-label="AI mode: live" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-6 py-1.5 text-[12px] text-muted md:px-10">
            <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">Live AI</span>
            <span>
              Text: Anthropic Claude · Images: {img.ready ? `OpenAI ${imageModelLabel(img.model ?? "")}` : "not configured"}. Requests use real providers and are billed.
            </span>
          </div>
        )}
        <main className="mx-auto max-w-[1280px] px-4 pb-28 pt-6 sm:px-6 md:px-10 md:pt-10">{children}</main>
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
