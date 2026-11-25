"use client";
import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { deleteAccount, deleteBrand, deleteWorkspace } from "@/app/actions/settings";
import { Button, Card, CardBody, CardHeader, Field, Input, Modal, Notice, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import type { AccountDeletionPlan } from "@/server/deletion";

type Target = "brand" | "workspace" | "account" | null;

/**
 * Settings → Delete data (PR 4.3). Brand deletion for organisation owners and admins with access to
 * every brand (the brand's name confirms); organisation deletion for owners and account deletion for
 * everyone (the password confirms). The server re-checks everything.
 */
export function DeleteData({ workspace, brands, canDeleteBrand, isOwner, plan }: { workspace: { id: string; name: string }; brands: { id: string; name: string }[]; canDeleteBrand: boolean; isOwner: boolean; plan: AccountDeletionPlan }) {
  const [open, setOpen] = useState<Target>(null);
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const { run, busy } = useRun();
  const brand = brands.find((b) => b.id === brandId);
  const close = () => {
    setOpen(null);
    setConfirm("");
    setPassword("");
  };
  // After deleting, the current page may refer to data that no longer exists: reload from the top.
  const leave = (to: string) => () => window.location.assign(to);

  return (
    <Card aria-label="Delete data">
      <CardHeader title="Delete data" description="Permanent. Deleted data can't be recovered." />
      <CardBody className="space-y-4 pt-3 text-[13px]">
        {canDeleteBrand && brands.length ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Delete a brand" className="min-w-[min(100%,14rem)] flex-1">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} aria-label="Brand to delete">
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="secondary" onClick={() => setOpen("brand")} disabled={!brand}>
              <Trash2 /> Delete brand…
            </Button>
          </div>
        ) : null}
        {isOwner ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">Delete the organisation <strong className="font-medium">{workspace.name}</strong> and all its brands.</span>
            <Button variant="secondary" onClick={() => setOpen("workspace")}>
              <Trash2 /> Delete organisation…
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0">Delete your BrandPilot account.</span>
          <Button variant="secondary" onClick={() => setOpen("account")}>
            <Trash2 /> Delete my account…
          </Button>
        </div>
        <p className="text-[11px] text-faint">
          Kept after deletion, without names, text or files: AI usage records (for billing) and security records. See the <a href="/data-deletion" className="underline">data deletion</a> page.
        </p>
      </CardBody>

      {open === "brand" && brand ? (
        <Modal open onClose={close} title={`Delete ${brand.name}?`}>
          <div className="space-y-4 p-5 text-[13px]">
            <p>
              This permanently deletes <strong className="font-medium">{brand.name}</strong>: its brand profile and memory, uploaded assets, strategies, campaigns, creatives and their images, posts and their
              metrics, connected social accounts, and its AI assistant history. Scheduled posts won&apos;t be published.
            </p>
            <Field label={`Type ${brand.name} to confirm`}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" aria-label="Brand name to confirm" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={confirm.trim() !== brand.name.trim()} loading={busy("del-brand")} onClick={() => run(() => deleteBrand(brand.id, confirm), { key: "del-brand", success: `${brand.name} was deleted`, refresh: false, onOk: leave("/dashboard") })}>
                Delete brand
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {open === "workspace" ? (
        <Modal open onClose={close} title={`Delete ${workspace.name}?`}>
          <div className="space-y-4 p-5 text-[13px]">
            <p>
              This permanently deletes the organisation <strong className="font-medium">{workspace.name}</strong>, all {brands.length === 1 ? "its brand" : `its ${brands.length} brands`} with everything in them, and
              every member&apos;s access to it. Cancel any paid subscription in Billing first.
            </p>
            <PasswordField value={password} onChange={setPassword} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={!password} loading={busy("del-ws")} onClick={() => run(() => deleteWorkspace(workspace.id, password), { key: "del-ws", success: `${workspace.name} was deleted`, refresh: false, onOk: leave("/dashboard") })}>
                Delete organisation
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {open === "account" ? (
        <Modal open onClose={close} title="Delete your account?">
          <div className="space-y-4 p-5 text-[13px]">
            {plan.blocked.length ? (
              <Notice tone="warn">
                <AlertTriangle className="mr-1 inline size-4" />
                You&apos;re the only owner of {plan.blocked.map((w) => w.name).join(", ")}, which {plan.blocked.length === 1 ? "has" : "have"} other members. Make one of them an owner, or delete the organisation, first.
              </Notice>
            ) : null}
            <ul className="space-y-1.5" aria-label="What happens to your organisations">
              {plan.deleted.map((w) => (
                <li key={w.id}>
                  <strong className="font-medium">{w.name}</strong>: deleted with all its brands (you&apos;re its only member).
                </li>
              ))}
              {plan.left.map((w) => (
                <li key={w.id}>
                  <strong className="font-medium">{w.name}</strong>: you leave it; it stays with its other members.
                </li>
              ))}
            </ul>
            <p>Your account, sign-ins and memberships are deleted and you&apos;re signed out.</p>
            <PasswordField value={password} onChange={setPassword} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={!password || plan.blocked.length > 0} loading={busy("del-acct")} onClick={() => run(() => deleteAccount(password), { key: "del-acct", refresh: false, onOk: leave("/login?deleted=1") })}>
                Delete my account
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Your password">
      <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="current-password" aria-label="Your password" />
    </Field>
  );
}
