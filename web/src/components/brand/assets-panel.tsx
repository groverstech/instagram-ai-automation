"use client";
import { useRef, useState } from "react";
import { AlertTriangle, Check, FileText, Presentation, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { analyzeAssetsAction, deleteAsset, setAssetStatus, uploadAssets } from "@/app/actions/brand";
import { Badge, Button, Card, CardBody, Empty, Field, Select } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { cn } from "@/lib/utils";

export const ASSET_KINDS = [
  { id: "logo", label: "Logo" },
  { id: "guideline", label: "Brand guidelines" },
  { id: "product", label: "Product images" },
  { id: "post", label: "Social media creatives" },
  { id: "creative", label: "Marketing creatives" },
  { id: "reference", label: "Reference designs" },
  { id: "presentation", label: "Brand presentation" },
  { id: "document", label: "Marketing document" },
] as const;

export const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.docx,.pptx,.txt,.md";
export const FORMATS_HINT = "PNG, JPG, WebP, GIF, SVG, PDF, DOCX, PPTX, TXT, MD · up to 15 MB each, 20 per upload";

export type AssetRow = {
  id: string;
  kind: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  analysis: Record<string, unknown> | null;
  analysisError: string | null;
  createdAt: Date;
};

const kindLabel = (k: string) => ASSET_KINDS.find((x) => x.id === k)?.label ?? k;
const isImage = (m: string) => m.startsWith("image/");

export function AssetsPanel({ brandId, assets, canEdit }: { brandId: string; assets: AssetRow[]; canEdit: boolean }) {
  const [kind, setKind] = useState("product");
  const [filter, setFilter] = useState("all");
  const input = useRef<HTMLInputElement>(null);
  const { run, busy } = useRun();
  const pending = assets.filter((a) => !a.analysis).length;
  const shown = assets.filter((a) => filter === "all" || a.status === filter);

  return (
    <div className="space-y-6">
      {canEdit ? (
        <Card>
          <CardBody className="flex flex-wrap items-end gap-3">
            <Field label="Asset type" className="w-full sm:w-56">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {ASSET_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const fd = new FormData();
                for (const f of Array.from(e.target.files ?? [])) fd.append(`asset_${kind}`, f);
                run(() => uploadAssets(brandId, fd), { key: "upload", success: (n) => `${n} file(s) uploaded. Analyse them or regenerate the profile.` });
                e.target.value = "";
              }}
            />
            <Button variant="secondary" loading={busy("upload")} onClick={() => input.current?.click()}>
              <Upload /> Upload files
            </Button>
            {pending ? (
              <Button variant="ai" loading={busy("analyze")} onClick={() => run(() => analyzeAssetsAction(brandId), { key: "analyze", success: (r) => `Analysed ${r.analyzed}${r.failed ? `, ${r.failed} failed` : ""}` })}>
                <RefreshCw /> Analyse {pending} pending
              </Button>
            ) : null}
            <p className="w-full text-[12px] text-faint sm:w-auto">{FORMATS_HINT}</p>
          </CardBody>
        </Card>
      ) : null}

      {assets.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {[
              ["all", "All"],
              ["approved", "Approved"],
              ["pending", "To review"],
              ["rejected", "Rejected"],
            ].map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)} className={cn("rounded-full border px-3 py-1", filter === v ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:bg-sunken")}>
                {l} ({v === "all" ? assets.length : assets.filter((a) => a.status === v).length})
              </button>
            ))}
            <span className="text-faint">Approved assets are used as references by every agent.</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((a) => {
              const facts = Array.isArray(a.analysis?.extractedFacts) ? (a.analysis!.extractedFacts as string[]) : [];
              const palette = Array.isArray(a.analysis?.palette) ? (a.analysis!.palette as string[]) : [];
              return (
                <Card key={a.id} className={cn("group flex flex-col overflow-hidden", a.status === "rejected" && "opacity-60")}>
                  <div className="relative">
                    {isImage(a.mime) && a.mime !== "image/svg+xml" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/assets/${a.id}`} alt={a.name} loading="lazy" className="aspect-[4/3] w-full bg-sunken object-contain p-2" />
                    ) : a.mime === "image/svg+xml" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/assets/${a.id}`} alt={a.name} loading="lazy" className="aspect-[4/3] w-full bg-sunken object-contain p-6" />
                    ) : (
                      <div className="grid aspect-[4/3] place-items-center bg-sunken text-muted">
                        {a.mime.includes("presentation") ? <Presentation className="size-9" /> : <FileText className="size-9" />}
                        <span className="-mt-6 text-[11px] uppercase tracking-wider text-faint">{a.name.split(".").pop()}</span>
                      </div>
                    )}
                    <div className="absolute left-2 top-2 flex gap-1">
                      <Badge className="bg-white/90 shadow-sm">{kindLabel(a.kind)}</Badge>
                      {a.status === "approved" ? (
                        <Badge tone="success" className="shadow-sm">
                          <Check /> Approved
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-1 flex-col p-3">
                    <p className="truncate text-[13px] font-medium" title={a.name}>
                      {a.name}
                    </p>
                    <p className="text-[11px] text-faint">{(a.size / 1024).toFixed(0)} KB</p>
                    {a.analysisError ? (
                      <p className="mt-2 flex gap-1.5 text-[12px] text-danger">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Analysis failed: {a.analysisError}
                      </p>
                    ) : a.analysis ? (
                      <div className="mt-2 space-y-1.5">
                        <p className="line-clamp-3 text-[12px] text-ink-2">{String(a.analysis.description ?? "")}</p>
                        {palette.length ? (
                          <div className="flex gap-1">
                            {palette.slice(0, 6).map((c) => (
                              <span key={c} title={c} className="size-4 rounded border border-black/5" style={{ background: c }} />
                            ))}
                          </div>
                        ) : null}
                        {facts.length ? (
                          <details className="text-[12px]">
                            <summary className="cursor-pointer text-muted">{facts.length} fact(s) found</summary>
                            <ul className="mt-1 space-y-0.5 text-ink-2">{facts.map((f) => <li key={f}>· {f}</li>)}</ul>
                          </details>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-2 text-[12px] text-faint">Not analysed yet</p>
                    )}
                    {canEdit ? (
                      <div className="mt-auto flex items-center gap-1 pt-3">
                        {a.status !== "approved" ? (
                          <Button size="sm" variant="secondary" className="h-7 px-2 text-[12px]" loading={busy(`ok-${a.id}`)} onClick={() => run(() => setAssetStatus(brandId, a.id, "approved"), { key: `ok-${a.id}`, success: "Asset approved as a brand reference" })}>
                            <Check /> Approve
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => run(() => setAssetStatus(brandId, a.id, "pending"))}>
                            Unapprove
                          </Button>
                        )}
                        {a.status !== "rejected" ? (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => run(() => setAssetStatus(brandId, a.id, "rejected"), { success: "Marked as not representative" })}>
                            <X /> Reject
                          </Button>
                        ) : null}
                        <button
                          onClick={() => confirm(`Delete ${a.name}?`) && run(() => deleteAsset(brandId, a.id), { success: "Asset deleted" })}
                          className="ml-auto rounded-md p-1 text-faint hover:text-danger"
                          aria-label={`Delete ${a.name}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      ) : (
        <Empty icon={<Upload />} title="No assets yet">
          Upload your logo, guidelines, product photos, past creatives, presentations or marketing documents so the agents learn your identity.
        </Empty>
      )}
    </div>
  );
}
