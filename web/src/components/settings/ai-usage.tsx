import { format } from "date-fns";
import { Activity, Cpu, ShieldAlert } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { AiOverview } from "@/server/ai/overview";

const usd = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const providerName = (p: string) => (p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : p === "mock" ? "Demo (no provider called)" : p);

/**
 * Settings → AI providers & usage. Organisation-wide: rendered only for owners and admins with
 * access to every brand (the server checks; see src/server/ai/overview.ts).
 */
export function AiUsageCard({ data }: { data: AiOverview }) {
  const t = data.usage.totals;
  const real = data.usage.byModel.filter((r) => r.provider !== "mock");
  const demoOnly = data.usage.byModel.length > 0 && real.length === 0;
  return (
    <Card aria-label="AI providers and usage">
      <CardHeader
        title="AI providers & usage"
        description={`This month (since ${format(data.usage.since, "d MMM")}), all brands.`}
        action={data.mode === "demo" ? <Badge tone="warn">Demo mode</Badge> : <Badge tone="success">Live providers</Badge>}
      />
      <CardBody className="space-y-5 pt-3 text-[13px]">
        <ul className="space-y-2.5">
          {data.providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <Cpu className="mt-0.5 size-4 shrink-0 text-faint" />
              <span className="min-w-[min(100%,12rem)] flex-1">
                <span className="block font-medium">{p.label}</span>
                <span className="block text-[11px] text-faint">{p.purpose}</span>
                <span className="block text-[11px] text-faint">{[p.model && `Model: ${p.model}`, p.detail].filter(Boolean).join(" · ")}</span>
              </span>
              {data.mode === "demo" ? (
                <Badge tone="warn">Not called in demo mode</Badge>
              ) : !p.configured ? (
                <Badge tone="danger">Not configured</Badge>
              ) : p.circuit !== "closed" ? (
                <Badge tone="warn">Degraded: requests paused</Badge>
              ) : (
                <Badge tone="success">Key configured</Badge>
              )}
            </li>
          ))}
        </ul>

        {data.live.status === "pending" ? (
          <Notice tone="warn">
            <span className="font-medium">Live provider validation: pending.</span> {data.live.reason} Results shown here come from automated tests with intercepted providers{data.mode === "demo" ? " and demo mode" : ""}, not from real generations.
          </Notice>
        ) : (
          <div className="rounded-xl border border-line p-3">
            <p className="text-[12px] font-medium">Live provider validation · {format(new Date(data.live.ranAt), "d MMM yyyy, HH:mm")}</p>
            <ul className="mt-1.5 space-y-1 text-[12px]">
              {data.live.results.map((r) => (
                <li key={r.name} className="flex justify-between gap-3">
                  <span className="text-muted">{r.name}</span>
                  <span className={cn(r.status === "passed" ? "text-success" : r.status === "not_run" ? "text-faint" : "text-danger")}>{r.status.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="AI requests" value={compact(t.attempts)} />
          <Stat label="Estimated cost" value={usd(real.reduce((s, r) => s + r.costUsd, 0))} hint={t.unpricedAttempts ? `+ ${t.unpricedAttempts} unpriced` : undefined} />
          <Stat label="Succeeded" value={compact(t.successes)} />
          <Stat label="Retried" value={compact(t.retried)} hint="transient errors" />
          <Stat label="Failed or refused" value={compact(t.failed + t.refused)} tone={t.failed + t.refused ? "warn" : undefined} />
          <Stat label="Outcome unknown" value={compact(t.unknown)} hint="may be billed" tone={t.unknown ? "warn" : undefined} />
        </dl>

        {data.limit.usd !== null ? (
          <div>
            <div className="mb-1 flex justify-between text-[12px]">
              <span className="text-muted">Monthly AI spending limit</span>
              <span>
                {usd(data.limit.spentUsd)} of {usd(data.limit.usd)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className={cn("h-full rounded-full", data.limit.spentUsd >= data.limit.usd ? "bg-danger" : "bg-ink")} style={{ width: `${Math.min(100, data.limit.usd ? (data.limit.spentUsd / data.limit.usd) * 100 : 100)}%` }} />
            </div>
          </div>
        ) : null}

        {data.usage.byModel.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-[12px]" aria-label="Usage by model">
              <thead className="text-faint">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Provider · model</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Requests</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Tokens in / out</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Cached reads</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Images</th>
                  <th className="py-1.5 text-right font-medium">Estimated cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.usage.byModel.map((r) => (
                  <tr key={`${r.provider}:${r.model}:${r.kind}`}>
                    <td className="py-1.5 pr-3">
                      {providerName(r.provider)}
                      {r.provider === "mock" ? <span className="text-faint"> · {r.kind === "image" ? "images" : "text"}</span> : r.model ? <span className="text-faint"> · {r.model}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.attempts}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.provider === "mock" ? "—" : `${compact(r.inputTokens)} / ${compact(r.outputTokens)}`}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.kind === "image" ? "—" : compact(r.cacheReadTokens)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.kind === "image" ? r.images : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.provider === "mock" ? "no cost" : r.unpricedAttempts && !r.costUsd ? "unpriced" : usd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-muted">
            <Activity className="size-4" /> No AI requests this month yet.
          </p>
        )}
        {demoOnly ? <p className="text-[11px] text-faint">All requests this month ran in demo mode: no provider was called and nothing was billed.</p> : null}

        {data.usage.byBrand.length ? (
          <div>
            <p className="mb-1.5 text-[12px] font-medium">By brand</p>
            <ul className="space-y-1 text-[12px]">
              {data.usage.byBrand.map((b) => (
                <li key={b.brandId ?? "none"} className="flex justify-between gap-3">
                  <span className="truncate text-muted">{b.brandId ? (data.usage.brandNames[b.brandId] ?? "Deleted brand") : "Not tied to a brand"}</span>
                  <span className="shrink-0 tabular-nums">
                    {b.attempts} requests · {usd(b.costUsd)}
                    {b.unpricedAttempts ? ` + ${b.unpricedAttempts} unpriced` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-[12px] font-medium">Which model does each job use?</summary>
          <ul className="mt-2 space-y-1 text-[12px]">
            {data.routes.map((r) => (
              <li key={r.key} className="flex justify-between gap-3">
                <span className="text-muted">{r.label}</span>
                <span className="shrink-0 text-right">
                  {r.model}
                  {r.source !== "default" ? <span className="text-faint"> · {r.source.replace("override:", "override, ")}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>

        <p className="flex gap-1.5 text-[11px] text-faint">
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          Costs here are <strong className="font-medium">estimates</strong>, calculated from the token usage each provider reports, at the rates shown above. Provider invoices are the source of truth: confirmed billing is reconciled for the whole platform from the providers&apos; cost reports, and every request stores the provider&apos;s request ID. Keys stay on the server.
        </p>
      </CardBody>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl bg-sunken/60 px-3 py-2">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className={cn("text-[15px] font-semibold tabular-nums", tone === "warn" && "text-warn")}>{value}</dd>
      {hint ? <dd className="text-[10px] text-faint">{hint}</dd> : null}
    </div>
  );
}
