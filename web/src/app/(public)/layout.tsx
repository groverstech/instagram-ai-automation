import Link from "next/link";
import { Sparkles } from "lucide-react";

/** Public pages that need no sign-in (legal text, data deletion). Platform reviewers and crawlers read these. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-white/70">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-ink text-white">
              <Sparkles className="size-3.5" />
            </span>
            BrandPilot
          </Link>
          <nav aria-label="Legal" className="flex gap-4 text-[13px] text-muted">
            <Link href="/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/data-deletion" className="hover:text-ink">
              Data deletion
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">{children}</main>
    </div>
  );
}
