"use client";
import Link from "next/link";
import { useState } from "react";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { changeRole, inviteMember, removeMember, updateWorkspace } from "@/app/actions/settings";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { PLANS, type PlanId } from "@/lib/plans";
import { ROLE_DESCRIPTIONS, roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";

type Member = { id: string; role: Role; status: string; invitedEmail: string | null; userId: string | null; name: string | null; email: string | null };

export function SettingsView(props: {
  role: Role;
  me: string;
  workspace: { id: string; name: string; type: "creator" | "business" | "agency"; plan: string };
  usage: { brands: number; seats: number; aiRuns: number; socialAccounts: number };
  members: Member[];
  brands: { id: string; name: string; createdAt: Date }[];
  integrations: { ai: { provider: string; ready: boolean; model: string }; image: { ready: boolean; provider: string }; embeddings: string; database: string };
}) {
  const isAdmin = roleAtLeast(props.role, "admin");
  const [name, setName] = useState(props.workspace.name);
  const [type, setType] = useState(props.workspace.type);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const { run, busy } = useRun();
  const plan = PLANS[(props.workspace.plan as PlanId) ?? "starter"] ?? PLANS.starter;

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Workspace" description="Team, roles, brands, plan and integrations." />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Workspace details" />
            <CardBody className="flex flex-wrap items-end gap-3">
              <Field label="Name" className="min-w-[220px] flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} /></Field>
              <Field label="Type" className="w-40">
                <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} disabled={!isAdmin}>
                  <option value="creator">Creator</option>
                  <option value="business">Business</option>
                  <option value="agency">Agency</option>
                </Select>
              </Field>
              {isAdmin ? <Button loading={busy("ws")} onClick={() => run(() => updateWorkspace(props.workspace.id, { name, type }), { key: "ws", success: "Saved" })}>Save</Button> : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Team" description={`${props.usage.seats} of ${plan.seats} seats`} />
            <CardBody className="space-y-4">
              {isAdmin ? (
                <div className="flex flex-wrap gap-2">
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className="min-w-[220px] flex-1" />
                  <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} className="w-32">
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                  <Button loading={busy("inv")} disabled={!email} onClick={() => run(() => inviteMember(props.workspace.id, email, inviteRole), { key: "inv", success: "Member added. Pending invites join when they sign up with this email.", onOk: () => setEmail("") })}>
                    <Plus /> Invite
                  </Button>
                </div>
              ) : null}
              <ul className="divide-y divide-line">
                {props.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{m.name ?? m.invitedEmail}</p>
                      <p className="truncate text-[11px] text-faint">{m.email ?? m.invitedEmail}{m.status === "invited" ? " · invitation pending" : ""}</p>
                    </div>
                    {isAdmin && m.userId !== props.me ? (
                      <Select value={m.role} onChange={(e) => run(() => changeRole(props.workspace.id, m.id, e.target.value as Role), { success: "Role updated" })} className="h-8 w-28 text-[12px]">
                        {(["owner", "admin", "editor", "viewer"] as Role[]).map((r) => <option key={r} value={r} className="capitalize">{r}</option>)}
                      </Select>
                    ) : (
                      <Badge className="capitalize">{m.role}</Badge>
                    )}
                    {isAdmin && m.userId !== props.me && m.role !== "owner" ? (
                      <Button size="icon" variant="ghost" onClick={() => run(() => removeMember(props.workspace.id, m.id), { success: "Removed" })} aria-label="Remove member"><Trash2 /></Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="grid gap-2 rounded-xl bg-sunken/60 p-3 text-[12px] sm:grid-cols-2">
                {(Object.keys(ROLE_DESCRIPTIONS) as Role[]).map((r) => (
                  <p key={r}><span className="font-medium capitalize">{r}:</span> <span className="text-muted">{ROLE_DESCRIPTIONS[r]}</span></p>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Brands" description={`${props.usage.brands} of ${plan.brands}`} action={isAdmin ? <Link href="/onboarding" className="text-[12px] font-medium text-muted hover:text-ink">+ Add brand</Link> : null} />
            <CardBody className="pt-3">
              <ul className="divide-y divide-line">
                {props.brands.map((b) => (
                  <li key={b.id} className="flex items-center justify-between py-2.5 text-[13px]">
                    <span className="font-medium">{b.name}</span>
                    <span className="text-[12px] text-faint">Created {format(b.createdAt, "d MMM yyyy")}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-faint">Each brand keeps separate memory, assets, campaigns and social connections.</p>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Plan & usage" action={<Badge tone="accent">{plan.label}</Badge>} />
            <CardBody className="space-y-3">
              <Meter label="AI runs this month" used={props.usage.aiRuns} max={plan.aiRunsPerMonth} />
              <Meter label="Brands" used={props.usage.brands} max={plan.brands} />
              <Meter label="Seats" used={props.usage.seats} max={plan.seats} />
              <Meter label="Social accounts" used={props.usage.socialAccounts} max={plan.socialAccounts} />
              <div className="grid grid-cols-3 gap-2 pt-2">
                {(Object.keys(PLANS) as PlanId[]).map((id) => (
                  <div key={id} className={cn("rounded-xl border p-3 text-center", id === props.workspace.plan ? "border-ink" : "border-line")}>
                    <p className="text-[12px] font-medium">{PLANS[id].label}</p>
                    <p className="text-[18px] font-semibold">${PLANS[id].price}</p>
                    <p className="text-[10px] text-faint">/ month</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-faint">Self-serve billing (Stripe) is on the Phase 8 roadmap. Contact us to change plans.</p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Integrations" />
            <CardBody className="space-y-3 text-[13px]">
              <Row k="Reasoning & copy" v={props.integrations.ai.ready ? `${props.integrations.ai.provider} · ${props.integrations.ai.model}` : "Not configured"} ok={props.integrations.ai.ready} />
              <Row k="Image generation" v={props.integrations.image.ready ? props.integrations.image.provider : "Typographic layouts only"} ok={props.integrations.image.ready} />
              <Row k="Brand memory embeddings" v={props.integrations.embeddings} ok />
              <Row k="Database" v={props.integrations.database} ok />
              <p className="text-[11px] text-faint">Keys are read from server environment variables and never sent to the browser.</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const p = Math.min(100, (used / max) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12px]"><span className="text-ink-2">{label}</span><span className="tabular-nums text-muted">{used} / {max}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken"><div className={cn("h-full rounded-full", p > 90 ? "bg-danger" : "bg-ink")} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className={cn("text-right", ok ? "text-ink" : "text-warn")}>{v}</span>
    </div>
  );
}
