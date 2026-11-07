"use client";
import { format } from "date-fns";
import { CheckCircle2, CircleSlash, Clock, Link2, Unplug } from "lucide-react";
import { disconnectAccount, setAccountBoard } from "@/app/actions/posts";
import { Badge, Button, Card, CardBody, Notice, PageHeader, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { platformColor } from "@/lib/domain";
import { roleAtLeast, type Role } from "@/lib/roles";
import type { Capabilities, Capability } from "@/server/social/types";

type Provider = { id: string; label: string; configured: boolean; capabilities: Capabilities; envKeys: string[] };
type Account = { id: string; platform: string; name: string; handle: string | null; avatarUrl: string | null; status: string; expiresAt: Date | null; createdAt: Date; boards: { id: string; name: string }[] | null; boardId: string | null };

const CAP_LABELS: [keyof Omit<Capabilities, "notes">, string][] = [
  ["publishImage", "Publish images"],
  ["publishCarousel", "Carousels"],
  ["publishVideo", "Video"],
  ["postAnalytics", "Post analytics"],
  ["accountAnalytics", "Account analytics"],
];

function Cap({ v }: { v: Capability }) {
  if (v === "supported") return <CheckCircle2 className="size-3.5 text-success" />;
  if (v === "requires_app_review") return <Clock className="size-3.5 text-warn" />;
  return <CircleSlash className="size-3.5 text-faint" />;
}

export function AccountsView({ brandId, role, providers, accounts, publicUrl, appUrl, connected, error }: { brandId: string; role: Role; providers: Provider[]; accounts: Account[]; publicUrl: boolean; appUrl: string; connected?: string; error?: string }) {
  const isAdmin = roleAtLeast(role, "admin");
  const { run, busy } = useRun();
  return (
    <div>
      <PageHeader eyebrow="Social Accounts" title="Connected accounts" description="Connect with each platform's official OAuth. BrandPilot only publishes where the platform's API allows it, and records the platform's real response." />

      {connected ? <Notice tone="success" className="mb-4">Connected {connected} account{connected === "1" ? "" : "s"}.</Notice> : null}
      {error ? <Notice tone="danger" className="mb-4">{error}</Notice> : null}
      {!publicUrl ? (
        <Notice tone="warn" className="mb-6">
          APP_URL is <code className="font-mono">{appUrl}</code>. Instagram, Facebook, Pinterest and TikTok download images from a public URL when publishing, and OAuth redirect URIs must be registered with each platform. Use a public https domain in production.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((p) => {
          const mine = accounts.filter((a) => a.platform === p.id);
          return (
            <Card key={p.id} className="overflow-hidden">
              <div className="h-1" style={{ background: platformColor(p.id) }} />
              <CardBody className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[16px] font-semibold">{p.label}</p>
                    <p className="mt-0.5 text-[12px] text-muted">{p.capabilities.notes}</p>
                  </div>
                  {isAdmin ? (
                    p.configured ? (
                      <a href={`/api/oauth/${p.id}/start?brand=${brandId}`} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-ink px-4 text-[13px] font-medium text-white hover:bg-ink-2">
                        <Link2 className="size-4" /> {mine.length ? "Add / refresh" : "Connect"}
                      </a>
                    ) : (
                      <Badge tone="outline" className="shrink-0" title={`Set ${p.envKeys.join(", ")}`}>Not configured</Badge>
                    )
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {CAP_LABELS.map(([k, l]) => (
                    <span key={k} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                      <Cap v={p.capabilities[k]} /> {l}
                    </span>
                  ))}
                </div>

                {!p.configured && isAdmin ? <p className="text-[11px] text-faint">Server env: {p.envKeys.join(", ")}</p> : null}

                {mine.length ? (
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {mine.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 p-3">
                        {a.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.avatarUrl} alt="" className="size-9 rounded-full bg-sunken object-cover" />
                        ) : (
                          <span className="size-9 rounded-full bg-sunken" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{a.name}</p>
                          <p className="text-[11px] text-faint">
                            {a.handle ? `@${a.handle} · ` : ""}connected {format(a.createdAt, "d MMM yyyy")}
                            {a.expiresAt ? ` · token expires ${format(a.expiresAt, "d MMM")}` : ""}
                          </p>
                          {a.boards?.length && isAdmin ? (
                            <Select className="mt-1.5 h-8 text-[12px]" value={a.boardId ?? ""} onChange={(e) => run(() => setAccountBoard(brandId, a.id, e.target.value), { success: "Board updated" })}>
                              {a.boards.map((b) => <option key={b.id} value={b.id}>Pin to: {b.name}</option>)}
                            </Select>
                          ) : null}
                        </div>
                        <Badge tone={a.status === "active" ? "success" : "danger"} className="capitalize">{a.status}</Badge>
                        {isAdmin ? (
                          <Button size="icon" variant="ghost" loading={busy(a.id)} onClick={() => confirm(`Disconnect ${a.name}?`) && run(() => disconnectAccount(brandId, a.id), { key: a.id, success: "Disconnected" })} aria-label="Disconnect">
                            <Unplug />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
      <p className="mt-6 flex flex-wrap items-center gap-4 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-success" /> Supported by the official API</span>
        <span className="flex items-center gap-1.5"><Clock className="size-3.5 text-warn" /> Needs platform app review / elevated access</span>
        <span className="flex items-center gap-1.5"><CircleSlash className="size-3.5 text-faint" /> Not offered by the API</span>
      </p>
    </div>
  );
}
