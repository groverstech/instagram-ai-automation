"use client";
import Link from "next/link";
import { useState } from "react";
import { format } from "date-fns";
import { ArrowLeftRight, Building2, Check, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { switchBrand } from "@/app/actions/brand";
import { changeRole, inviteMember, removeMember, setMemberBrands, updateWorkspace } from "@/app/actions/settings";
import { openBillingPortal, startCheckout } from "@/app/actions/billing";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Modal, Notice, PageHeader, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { PLANS, type PlanId } from "@/lib/plans";
import { ROLE_DESCRIPTIONS, roleAtLeast, type Role } from "@/lib/roles";
import { cn } from "@/lib/utils";

type Member = { id: string; role: Role; brandIds: string[] | null; status: string; invitedEmail: string | null; userId: string | null; name: string | null; email: string | null };
type BrandRow = { id: string; name: string; createdAt: Date; active: boolean; colors: string[]; access: { all: number; scoped: number } };

export function SettingsView(props: {
  role: Role;
  me: string;
  scoped?: boolean;
  brandLimit: number;
  canAddBrand: boolean;
  workspace: { id: string; name: string; type: "creator" | "business" | "agency"; plan: string };
  billing: {
    configured: boolean;
    prices: { growth: boolean; agency: boolean };
    notice?: "success" | "cancelled";
    hasCustomer: boolean;
    status: string | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  };
  usage: { brands: number; seats: number; aiRuns: number; socialAccounts: number };
  members: Member[];
  brands: BrandRow[];
  integrations: { ai: { provider: string; ready: boolean; model: string }; image: { ready: boolean; provider: string }; embeddings: string; database: string };
}) {
  const isAdmin = roleAtLeast(props.role, "admin") && !props.scoped;
  const [name, setName] = useState(props.workspace.name);
  const [type, setType] = useState(props.workspace.type);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [inviteScope, setInviteScope] = useState<string[] | null>(null);
  const [scopeFor, setScopeFor] = useState<Member | "invite" | null>(null);
  const router = useRouter();
  const isAgency = props.workspace.type === "agency";
  const brandName = (id: string) => props.brands.find((b) => b.id === id)?.name ?? "Unknown brand";
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
                  {props.brands.length > 1 || isAgency ? (
                    <Button variant="secondary" onClick={() => setScopeFor("invite")} aria-label="Brand access for the invitation">
                      <Building2 /> {scopeLabel(inviteScope, brandName, props.brands.length)}
                    </Button>
                  ) : null}
                  <Button loading={busy("inv")} disabled={!email} onClick={() => run(() => inviteMember(props.workspace.id, email, inviteRole, inviteScope), { key: "inv", success: "Member added. Pending invites join when they sign up with this email.", onOk: () => { setEmail(""); setInviteScope(null); } })}>
                    <Plus /> Invite
                  </Button>
                </div>
              ) : null}
              <ul className="divide-y divide-line">
                {props.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{m.name ?? m.invitedEmail}</p>
                      <p className="truncate text-[11px] text-faint">{m.email ?? m.invitedEmail}{m.status === "invited" ? " · invitation pending" : ""}{m.brandIds ? ` · client access: ${m.brandIds.map(brandName).join(", ")}` : m.role === "owner" || m.role === "admin" ? " · all brands" : ""}</p>
                    </div>
                    {isAdmin && m.userId !== props.me && (m.role === "editor" || m.role === "viewer") && (props.brands.length > 1 || isAgency) ? (
                      <Button size="sm" variant="secondary" onClick={() => setScopeFor(m)} aria-label={`Brand access for ${m.name ?? m.invitedEmail}`}>
                        <Building2 /> {scopeLabel(m.brandIds, brandName, props.brands.length)}
                      </Button>
                    ) : null}
                    {isAdmin && m.userId !== props.me ? (
                      <Select value={m.role} onChange={(e) => run(() => changeRole(props.workspace.id, m.id, e.target.value as Role), { success: "Role updated" })} className="h-8 w-28 text-[12px]">
                        {(m.brandIds ? (["editor", "viewer"] as Role[]) : (["owner", "admin", "editor", "viewer"] as Role[])).map((r) => <option key={r} value={r} className="capitalize">{r}</option>)}
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
            <CardHeader
              title="Brands"
              description={props.scoped ? "The brands you have access to" : `${props.usage.brands} of ${props.brandLimit} on your plan`}
              action={
                props.canAddBrand ? (
                  <Link href="/onboarding" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent-ink"><Plus className="size-3.5" /> Add brand</Link>
                ) : isAdmin ? (
                  <span className="text-[11px] text-faint">Brand limit reached · upgrade to add more</span>
                ) : null
              }
            />
            <CardBody className="pt-3">
              <ul className="divide-y divide-line">
                {props.brands.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold text-white" style={{ background: b.colors[0] ?? "#1b1a17" }}>
                      {b.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{b.name}</span>
                      <span className="block text-[11px] text-faint">
                        Created {format(new Date(b.createdAt), "d MMM yyyy")}
                        {!props.scoped ? ` · ${b.access.all + b.access.scoped} member${b.access.all + b.access.scoped === 1 ? "" : "s"} with access${b.access.scoped ? ` (${b.access.scoped} client)` : ""}` : ""}
                      </span>
                    </span>
                    {b.active ? (
                      <Badge tone="success"><Check /> Current</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" loading={busy(`sw-${b.id}`)} onClick={() => run(() => switchBrand(b.id), { key: `sw-${b.id}`, success: `Switched to ${b.name}`, onOk: () => router.refresh() })}>
                        <ArrowLeftRight /> Switch
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-faint">Each brand keeps separate memory, assets, strategies, campaigns and social connections. Switching changes the brand every page works on.</p>
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
            </CardBody>
          </Card>

          <BillingCard workspaceId={props.workspace.id} currentPlan={props.workspace.plan} isOwner={props.role === "owner"} billing={props.billing} />

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
      {scopeFor ? (
        <BrandAccessModal
          title={scopeFor === "invite" ? "Brand access for the invitation" : `Brand access · ${scopeFor.name ?? scopeFor.invitedEmail}`}
          brands={props.brands}
          initial={scopeFor === "invite" ? inviteScope : scopeFor.brandIds}
          saving={busy("scope")}
          onClose={() => setScopeFor(null)}
          onSave={(ids) => {
            if (scopeFor === "invite") {
              setInviteScope(ids);
              setScopeFor(null);
            } else run(() => setMemberBrands(props.workspace.id, scopeFor.id, ids), { key: "scope", success: "Brand access updated", onOk: () => setScopeFor(null) });
          }}
        />
      ) : null}
    </div>
  );
}

function scopeLabel(ids: string[] | null, name: (id: string) => string, total: number) {
  if (!ids) return "All brands";
  if (ids.length === 1) return `Only ${name(ids[0])}`;
  return `${ids.length} of ${total} brands`;
}

/** Choose "all brands" or a specific set of brands for a client user. */
function BrandAccessModal({ title, brands, initial, saving, onClose, onSave }: { title: string; brands: BrandRow[]; initial: string[] | null; saving: boolean; onClose: () => void; onSave: (ids: string[] | null) => void }) {
  const [all, setAll] = useState(initial === null);
  const [sel, setSel] = useState<string[]>(initial ?? []);
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <label className="flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px]">
            <input type="radio" name="scope" className="mt-0.5" checked={all} onChange={() => setAll(true)} />
            <span><span className="font-medium">All brands</span><span className="block text-[12px] text-muted">Including brands added later. For your own team.</span></span>
          </label>
          <label className="flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px]">
            <input type="radio" name="scope" className="mt-0.5" checked={!all} onChange={() => setAll(false)} />
            <span><span className="font-medium">Only selected brands</span><span className="block text-[12px] text-muted">For clients: they see nothing from other brands.</span></span>
          </label>
        </div>
        {!all ? (
          <fieldset className="space-y-1.5" aria-label="Brands">
            {brands.map((b) => (
              <label key={b.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sunken">
                <input type="checkbox" checked={sel.includes(b.id)} onChange={(e) => setSel(e.target.checked ? [...sel, b.id] : sel.filter((x) => x !== b.id))} />
                {b.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={saving} disabled={!all && !sel.length} onClick={() => onSave(all ? null : sel)}>Save access</Button>
        </div>
      </div>
    </Modal>
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

const STATUS_TONE: Record<string, string> = { active: "success", trialing: "info", past_due: "warn", unpaid: "danger", canceled: "neutral", incomplete: "warn", incomplete_expired: "neutral", paused: "neutral" };

function BillingCard({ workspaceId, currentPlan, isOwner, billing }: { workspaceId: string; currentPlan: string; isOwner: boolean; billing: Parameters<typeof SettingsView>[0]["billing"] }) {
  const { run, busy } = useRun();
  const subscribed = ["active", "trialing", "past_due"].includes(billing.status ?? "");
  const go = (url: string) => {
    window.location.href = url;
  };
  return (
    <Card>
      <CardHeader
        title="Billing"
        description={billing.configured ? "Payments are handled securely by Stripe." : "Stripe isn't configured on this server."}
        action={billing.status ? <Badge tone={STATUS_TONE[billing.status] ?? "neutral"} className="capitalize">{billing.status.replace("_", " ")}</Badge> : null}
      />
      <CardBody className="space-y-3">
        {billing.notice === "success" ? (
          <Notice tone="success">Thanks! Your plan updates as soon as Stripe confirms the payment, usually within a few seconds. Refresh if it hasn&apos;t changed yet.</Notice>
        ) : null}
        {billing.notice === "cancelled" ? <Notice tone="info">Checkout was cancelled. You haven&apos;t been charged.</Notice> : null}
        {billing.status === "past_due" ? <Notice tone="warn">Your last payment failed. Stripe is retrying; update your payment method to keep your plan.</Notice> : null}
        {billing.currentPeriodEnd && billing.status !== "canceled" ? (
          <p className="text-[12px] text-muted">
            {billing.cancelAtPeriodEnd ? "Cancels" : "Renews"} on {format(billing.currentPeriodEnd, "d MMM yyyy")}
            {billing.cancelAtPeriodEnd ? " — you'll move to Starter then." : "."}
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(PLANS) as PlanId[]).map((id) => {
            const current = id === currentPlan;
            const purchasable = id !== "starter" && billing.configured && billing.prices[id as "growth" | "agency"];
            return (
              <div key={id} className={cn("flex flex-col rounded-xl border p-3 text-center", current ? "border-ink" : "border-line")}>
                <p className="text-[12px] font-medium">{PLANS[id].label}</p>
                <p className="text-[18px] font-semibold">${PLANS[id].price}</p>
                <p className="text-[10px] text-faint">/ month</p>
                <div className="mt-2 flex-1" />
                {current ? (
                  <span className="text-[11px] font-medium text-ink-2">Current</span>
                ) : isOwner && purchasable && !subscribed ? (
                  <Button size="sm" variant="accent" className="h-7 text-[11px]" loading={busy(id)} onClick={() => run(() => startCheckout(workspaceId, id as "growth" | "agency"), { key: id, refresh: false, onOk: (d) => go(d.url) })}>
                    Upgrade
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>

        {isOwner && billing.configured && billing.hasCustomer ? (
          <Button variant="secondary" className="w-full" loading={busy("portal")} onClick={() => run(() => openBillingPortal(workspaceId), { key: "portal", refresh: false, onOk: (d) => go(d.url) })}>
            Manage billing, plan &amp; invoices
          </Button>
        ) : null}
        {!isOwner ? <p className="text-[11px] text-faint">Only workspace owners can change billing.</p> : null}
        {!billing.configured ? <p className="text-[11px] text-faint">Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the plan price ids to enable self-serve billing.</p> : null}
        <p className="text-[11px] text-faint">Downgrading keeps your existing brands, members and accounts; you just can&apos;t add more beyond the new plan&apos;s limits.</p>
      </CardBody>
    </Card>
  );
}
