"use client";
import { useState } from "react";
import { platformColor, platformLabel } from "@/lib/domain";

/**
 * Small, dependency-free charts for the strategy dashboard. Categorical colours use the validated
 * reference order (fixed slots, never cycled; checked with the dataviz palette validator on the
 * light surface). Text always uses ink tokens; identity is never colour-only (legend + labels).
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SEQ = "#2a78d6";

function useTip() {
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  return { tip, show: (x: number, text: string) => setTip({ x, text }), hide: () => setTip(null) };
}

function Tip({ tip }: { tip: { x: number; text: string } | null }) {
  if (!tip) return null;
  return (
    <div className="pointer-events-none absolute -top-9 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] text-white shadow-pop" style={{ left: `${tip.x}%` }}>
      {tip.text}
    </div>
  );
}

/** Share of content per pillar: one stacked bar + legend with values. */
export function PillarShare({ pillars }: { pillars: { name: string; sharePercent: number }[] }) {
  const { tip, show, hide } = useTip();
  let acc = 0;
  return (
    <figure>
      <div className="relative" onMouseLeave={hide}>
        <Tip tip={tip} />
        <div className="flex h-3.5 gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={`Content mix: ${pillars.map((p) => `${p.name} ${p.sharePercent}%`).join(", ")}`}>
          {pillars.map((p, i) => {
            const mid = acc + p.sharePercent / 2;
            acc += p.sharePercent;
            return <div key={p.name} className="h-full first:rounded-l-[4px] last:rounded-r-[4px]" style={{ width: `${p.sharePercent}%`, background: SERIES[i % SERIES.length] }} onMouseEnter={() => show(mid, `${p.name} · ${p.sharePercent}%`)} />;
          })}
        </div>
      </div>
      <figcaption className="mt-3 grid gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-2">
        {pillars.map((p, i) => (
          <span key={p.name} className="flex items-center gap-2 text-ink-2">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="tabular-nums text-muted">{p.sharePercent}%</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Posts per platform in the calendar (horizontal bars, platform identity colours + labels). */
export function PlatformMix({ counts }: { counts: { platform: string; n: number }[] }) {
  const max = Math.max(1, ...counts.map((c) => c.n));
  return (
    <div className="space-y-2.5" role="list">
      {counts.map((c) => (
        <div key={c.platform} role="listitem" className="grid grid-cols-[88px_1fr_32px] items-center gap-3 text-[12px]" title={`${platformLabel(c.platform)}: ${c.n} posts`}>
          <span className="truncate text-ink-2">{platformLabel(c.platform)}</span>
          <div className="h-2.5 rounded-r-[4px] bg-sunken">
            <div className="h-full rounded-r-[4px]" style={{ width: `${(c.n / max) * 100}%`, background: platformColor(c.platform) }} />
          </div>
          <span className="text-right tabular-nums text-muted">{c.n}</span>
        </div>
      ))}
    </div>
  );
}

/** Posts per week across the 30-day window (single-hue columns). */
export function WeeklyCadence({ weeks }: { weeks: { label: string; n: number }[] }) {
  const { tip, show, hide } = useTip();
  const max = Math.max(1, ...weeks.map((w) => w.n));
  return (
    <div className="relative" onMouseLeave={hide}>
      <Tip tip={tip} />
      <div className="flex h-28 items-end gap-2 border-b border-line">
        {weeks.map((w, i) => (
          <div key={w.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1" onMouseEnter={() => show(((i + 0.5) / weeks.length) * 100, `${w.label}: ${w.n} posts`)}>
            <span className="text-[11px] tabular-nums text-muted">{w.n}</span>
            <div className="w-full max-w-10 rounded-t-[4px]" style={{ height: `${(w.n / max) * 80}%`, background: SEQ }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {weeks.map((w) => (
          <span key={w.label} className="flex-1 text-center text-[11px] text-faint">
            {w.label}
          </span>
        ))}
      </div>
    </div>
  );
}
