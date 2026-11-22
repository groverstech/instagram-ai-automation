import type { Metadata } from "next";
import { format } from "date-fns";
import { deletionStatus } from "@/server/platforms/meta-callbacks";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Data deletion status · BrandPilot", robots: { index: false } };

const LABEL = { received: "Received, in progress", completed: "Completed", failed: "Couldn't be completed automatically. We'll finish it manually and email you if we need anything." } as const;

/** Meta's data-deletion status URL: shows status and dates for a confirmation code, nothing else. */
export default async function DeletionStatus({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = ((await searchParams).code ?? "").trim().toUpperCase();
  const r = code ? await deletionStatus(code) : null;
  return (
    <div className="space-y-5 text-[15px] text-ink-2">
      <h1 className="font-display text-[32px] leading-tight text-ink">Data deletion status</h1>
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Look up a deletion request">
        <label className="flex flex-col gap-1 text-[13px]">
          Confirmation code
          <input name="code" defaultValue={code} maxLength={12} autoComplete="off" className="h-10 w-56 rounded-lg border border-line bg-white px-3 font-mono uppercase tracking-wider" />
        </label>
        <button className="h-10 rounded-lg bg-ink px-4 text-[13px] font-medium text-white">Check</button>
      </form>
      {code ? (
        r ? (
          <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-white p-4 text-[14px]" aria-label="Request status">
            <dt className="text-muted">Status</dt>
            <dd className="font-medium">{LABEL[r.status]}</dd>
            <dt className="text-muted">Requested</dt>
            <dd>{format(r.requestedAt, "d MMM yyyy, HH:mm")} UTC</dd>
            {r.completedAt ? (
              <>
                <dt className="text-muted">Completed</dt>
                <dd>{format(r.completedAt, "d MMM yyyy, HH:mm")} UTC</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p role="status">No deletion request matches that code. Check it and try again.</p>
        )
      ) : (
        <p>Enter the confirmation code you received when you asked Meta to delete your BrandPilot data.</p>
      )}
    </div>
  );
}
