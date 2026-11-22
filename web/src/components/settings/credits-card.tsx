"use client";
import { useState } from "react";
import { format } from "date-fns";
import { setCreditCap } from "@/app/actions/credits";
import { Badge, Button, Card, CardBody, CardHeader, Input, Notice } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { cn } from "@/lib/utils";
import type { CreditStatus } from "@/server/credits";

export type CreditView = CreditStatus & { brandNames: Record<string, string> };

const KIND: Record<string, string> = { text: "Text", image: "Images", research: "Web research", video: "Video" };
const n = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString("en"));

/**
 * Settings → AI credits (PR 4.5, shadow mode): this month's credits by kind, brand and route, the
 * organisation and brand caps, and the alerts reached. Owners and admins with access to every brand.
 */
export function CreditsCard({ workspaceId, view }: { workspaceId: string; view: CreditView }) {
  const { run, busy } = useRun();
  const [editing, setEditing] = useState<string | null>(null); // "" = organisation, else brand id
  const [value, setValue] = useState("");
  const brandName = (id: string | null) => (id ? (view.brandNames[id] ?? "Deleted brand") : "No brand");
  const capFor = (brandId: string) => view.brands.find((b) => b.brandId === brandId);
  const save = (brandId: string, credits: number | null) =>
    run(() => setCreditCap(workspaceId, brandId || null, credits), {
      key: `cap:${brandId}`,
      success: credits === null ? "Cap removed" : "Cap saved",
      onOk: () => setEditing(null),
    });
  const editor = (brandId: string, current: number | null) =>
    editing === brandId ? (
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save(brandId, Number(value));
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" className="h-8 w-32" aria-label={brandId ? `Monthly cap for ${brandName(brandId)}` : "Organisation monthly cap"} autoFocus />
        <span className="text-[12px] text-muted">credits / month</span>
        <Button size="sm" type="submit" disabled={!value} loading={busy(`cap:${brandId}`)}>
          Save
        </Button>
        {current !== null ? (
          <Button size="sm" type="button" variant="ghost" onClick={() => save(brandId, null)}>
            Remove cap
          </Button>
        ) : null}
        <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </form>
    ) : (
      <button
        type="button"
        className="text-[12px] font-medium text-accent hover:text-accent-ink"
        onClick={() => {
          setEditing(brandId);
          setValue(current === null ? "" : String(current));
        }}
      >
        {current === null ? "Set a cap" : "Change cap"}
      </button>
    );

  const orgOwnCap = view.org?.source === "organisation" ? view.org.cap : null;
  return (
    <Card aria-label="AI credits">
      <CardHeader
        title="AI credits"
        description={`${format(view.since, "MMMM yyyy")} · 1 credit = $${view.settings.creditValueUsd} of estimated provider cost`}
        action={view.mode === "shadow" ? <Badge tone="info">Preview</Badge> : <Badge>Not tracked</Badge>}
      />
      <CardBody className="space-y-4 text-[13px]">
        <Notice tone="info">
          Credits are shown for information while they&apos;re introduced. Nothing is stopped on credits yet: your plan&apos;s monthly AI-run limit is what applies.
        </Notice>

        <div>
          <div className="mb-1 flex justify-between text-[12px]">
            <span className="text-ink-2">Organisation</span>
            <span className="tabular-nums text-muted">
              {n(view.used)}
              {view.org ? ` / ${view.org.cap.toLocaleString("en")}` : ""} credits
            </span>
          </div>
          {view.org ? <Bar percent={view.org.percent} /> : null}
          <p className="mt-1 text-[11px] text-faint">
            {view.org
              ? view.org.source === "plan"
                ? `The ${view.plan.name} plan includes ${view.org.cap.toLocaleString("en")} credits a month.`
                : `Your organisation's cap (${view.plan.name} plan${view.plan.includedCredits != null ? `: ${view.plan.includedCredits.toLocaleString("en")} included` : ""}).`
              : "No monthly allowance is set for this plan yet, and no organisation cap."}
          </p>
          <div className="mt-1">{editor("", orgOwnCap)}</div>
        </div>

        {view.byKind.length ? (
          <div className="grid grid-cols-3 gap-2" aria-label="Credits by kind">
            {view.byKind.map((k) => (
              <div key={k.kind} className="rounded-lg bg-sunken px-3 py-2">
                <p className="text-[11px] text-muted">{KIND[k.kind] ?? k.kind}</p>
                <p className="font-semibold tabular-nums">{n(k.credits)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted">No AI credits used this month yet.</p>
        )}

        <div>
          <p className="mb-2 text-[12px] font-medium text-ink-2">By brand</p>
          <ul className="divide-y divide-line" aria-label="Credits by brand">
            {Object.keys(view.brandNames).map((id) => {
              const used = view.byBrand.find((b) => b.brandId === id)?.credits ?? 0;
              const cap = capFor(id);
              return (
                <li key={id} className="py-2">
                  <div className="flex justify-between gap-2 text-[12px]">
                    <span>{brandName(id)}</span>
                    <span className="tabular-nums text-muted">
                      {n(used)}
                      {cap ? ` / ${cap.cap.toLocaleString("en")}` : ""}
                    </span>
                  </div>
                  {cap ? <Bar percent={cap.percent} className="mt-1" /> : null}
                  <div className="mt-1">{editor(id, cap?.cap ?? null)}</div>
                </li>
              );
            })}
          </ul>
        </div>

        {view.byRoute.length ? (
          <div>
            <p className="mb-1 text-[12px] font-medium text-ink-2">What used the most</p>
            <ul className="space-y-0.5 text-[12px]" aria-label="Credits by AI job">
              {view.byRoute.map((r) => (
                <li key={r.route} className="flex justify-between">
                  <span className="font-mono text-[11px] text-muted">{r.route}</span>
                  <span className="tabular-nums">{n(r.credits)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.alerts.length ? (
          <div aria-label="Credit alerts this month">
            <p className="mb-1 text-[12px] font-medium text-ink-2">Alerts this month</p>
            <ul className="space-y-0.5 text-[12px] text-muted">
              {view.alerts.map((a) => (
                <li key={`${a.brandId}:${a.threshold}`}>
                  {a.threshold}% of {a.brandId ? `${brandName(a.brandId)}'s cap` : "the organisation's credits"} · {format(a.at, "d MMM, HH:mm")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-[11px] text-faint">
          Alerts at {view.settings.alertThresholds.join("%, ")}% go to owners and admins. Demo calls aren&apos;t counted.{" "}
          {view.settings.chargeFailedAttempts ? "Failed and retried attempts are counted." : `Failed and retried attempts aren't counted${view.notCharged > 0 ? ` (${n(view.notCharged)} credits this month)` : ""}.`}
        </p>
      </CardBody>
    </Card>
  );
}

function Bar({ percent, className }: { percent: number; className?: string }) {
  const p = Math.min(100, percent);
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-sunken", className)} role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full", percent >= 100 ? "bg-danger" : percent >= 90 ? "bg-warn" : "bg-ink")} style={{ width: `${p}%` }} />
    </div>
  );
}
