import { Badge } from "@/components/ui";
import { POST_STATUS_META, platformColor, platformLabel } from "@/lib/domain";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const m = POST_STATUS_META[status] ?? { label: status, tone: "neutral" };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function PlatformTag({ platform, className }: { platform: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] text-ink-2", className)}>
      <span className="size-2 rounded-full" style={{ background: platformColor(platform) }} />
      {platformLabel(platform)}
    </span>
  );
}

export function CreativeThumb({ id, format = "instagram_square", className, alt = "Creative preview" }: { id: string; format?: string; className?: string; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/api/creatives/${id}/image?format=${format}`} alt={alt} loading="lazy" className={cn("bg-sunken object-cover", className)} />;
}

export function SourceTag({ source }: { source: "platform" | "estimate" | "ai" }) {
  const map = { platform: ["Platform data", "success"], estimate: ["Estimate", "warn"], ai: ["AI recommendation", "accent"] } as const;
  const [label, tone] = map[source];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Rationale({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <details className="group mt-3 rounded-xl bg-sunken/60 px-3.5 py-2.5 text-[13px] text-ink-2">
      <summary className="cursor-pointer list-none text-[12px] font-medium text-muted group-open:mb-1.5">Why this? <span className="text-faint">· AI reasoning</span></summary>
      {children}
    </details>
  );
}
