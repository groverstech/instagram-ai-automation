import { format } from "date-fns";
import type { LegalDoc } from "@/server/legal";

export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <article className="space-y-4 text-[15px] leading-relaxed text-ink-2">
      {doc.status === "draft" ? (
        <div role="note" className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px] text-warn">
          <strong className="font-semibold">Draft.</strong> This text hasn&apos;t been approved and isn&apos;t in effect yet.
        </div>
      ) : null}
      {doc.body}
      {doc.updated ? <p className="pt-6 text-[12px] text-faint">Last updated {format(new Date(`${doc.updated}T00:00:00Z`), "d MMMM yyyy")}</p> : null}
    </article>
  );
}
