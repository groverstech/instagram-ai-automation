import { Sparkles } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden ai-gradient lg:flex lg:flex-col lg:justify-between lg:p-14">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
            <Sparkles className="size-4" />
          </span>
          BrandPilot
        </div>
        <div className="max-w-md">
          <p className="font-display text-[46px] leading-[1.05] text-ink">An AI marketing team that learns your brand first.</p>
          <p className="mt-5 text-[15px] text-ink-2">
            Strategy, creatives, captions, campaigns and analytics, all grounded in your brand&apos;s identity and approved by you before anything goes live.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-[12px] text-ink-2">
          {["Brand intelligence", "Creative studio", "Campaign manager"].map((t) => (
            <div key={t} className="rounded-xl border border-white/70 bg-white/60 px-3 py-2.5 backdrop-blur">
              {t}
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute -right-32 -top-32 size-[420px] rounded-full bg-[#c9bff7] opacity-40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 left-10 size-[380px] rounded-full bg-[#f6c8b0] opacity-40 blur-3xl" />
      </aside>
      <main className="flex items-center justify-center p-6 md:p-12">{children}</main>
    </div>
  );
}
