"use client";
import { useState } from "react";
import { Check, CircleDashed, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { saveProfile, setSectionStatusAction } from "@/app/actions/brand";
import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { PLATFORMS, STYLES, platformLabel, styleById } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { EDITED, SECTIONS, editOne, linesToFindings, sectionSources, type BrandProfileV2, type Finding, type SectionId, type SectionStatus, type Source } from "@/lib/brand-profile";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const SOURCE_META: Record<Source, { label: string; className: string; dot: string }> = {
  provided: { label: "You said", className: "bg-success-soft text-success", dot: "bg-success" },
  observed: { label: "Observed", className: "bg-info-soft text-info", dot: "bg-info" },
  inferred: { label: "AI suggestion", className: "bg-accent-soft text-accent-ink", dot: "bg-accent" },
};

export function SourceChip({ source, evidence }: { source: Source; evidence?: string }) {
  const m = SOURCE_META[source];
  return (
    <span title={evidence ? `${m.label}: ${evidence}` : m.label} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium", m.className)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function SourceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
      {(Object.keys(SOURCE_META) as Source[]).map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <SourceChip source={s} />
          {s === "provided" ? "from your answers or edits" : s === "observed" ? "from your website or uploads" : "needs your confirmation"}
        </span>
      ))}
    </div>
  );
}

function FindingList({ items, empty = "Nothing yet" }: { items: Finding[]; empty?: string }) {
  const shown = items.filter((i) => i.text.trim());
  if (!shown.length) return <p className="text-[13px] text-faint">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {shown.map((f, i) => (
        <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[13px]">
          <span className="min-w-0 flex-1">{f.text}</span>
          <SourceChip source={f.source} evidence={f.evidence} />
        </li>
      ))}
    </ul>
  );
}

function OneFinding({ f }: { f: Finding }) {
  if (!f.text.trim()) return <p className="text-[13px] text-faint">Not determined</p>;
  return (
    <p className="flex flex-wrap items-start gap-2 text-[13px]">
      <span className="min-w-0 flex-1">{f.text}</span>
      <SourceChip source={f.source} evidence={f.evidence} />
    </p>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</p>;

const Chips = ({ items }: { items: string[] }) =>
  items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i} className="rounded-full bg-sunken px-2.5 py-0.5 text-[12px] text-ink-2">
          {i}
        </span>
      ))}
    </div>
  ) : (
    <p className="text-[13px] text-faint">None yet</p>
  );

// ---------------------------------------------------------------------------
// Editing helpers: unchanged lines keep their provenance; new or edited lines become "provided".
// ---------------------------------------------------------------------------

const csv = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function ListEditor({ label, value, onChange, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <Label>{label} · one per line</Label>
      <Textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

export function ProfileSections({
  brandId,
  profileId,
  profile,
  sectionStatus,
  canEdit,
  locked,
}: {
  brandId: string;
  profileId: string;
  profile: BrandProfileV2;
  sectionStatus: SectionStatus;
  canEdit: boolean;
  locked: boolean;
}) {
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [draft, setDraft] = useState<BrandProfileV2>(profile);
  const { run, busy } = useRun();

  const start = (id: SectionId) => {
    setDraft(profile);
    setEditing(id);
  };
  const save = () => run(() => saveProfile(brandId, profileId, draft), { key: "save", success: "Section saved", onOk: () => setEditing(null) });

  return (
    <div className="space-y-5">
      {SECTIONS.map((s) => {
        const status = sectionStatus[s.id] ?? "needs_review";
        const sources = sectionSources(profile, s.id);
        const pending = sources.filter((x) => x === "inferred").length;
        const isEditing = editing === s.id;
        const p = isEditing ? draft : profile;
        return (
          <Card key={s.id} id={`section-${s.id}`} className={cn("overflow-hidden", isEditing && "ring-2 ring-accent/30")}>
            <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold">{s.label}</h3>
                  {status === "confirmed" ? (
                    <Badge tone="success">
                      <Check /> Confirmed
                    </Badge>
                  ) : (
                    <Badge tone="warn">
                      <CircleDashed /> Needs review
                    </Badge>
                  )}
                  {pending > 0 && status !== "confirmed" ? <span className="text-[12px] text-muted">{pending} AI suggestion{pending > 1 ? "s" : ""} to check</span> : null}
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{s.hint}</p>
              </div>
              {canEdit && !locked ? (
                <div className="flex shrink-0 gap-2">
                  {isEditing ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" loading={busy("save")} onClick={save}>
                        Save
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => start(s.id)} disabled={editing !== null}>
                        <Pencil /> Edit
                      </Button>
                      {status === "confirmed" ? (
                        <Button variant="ghost" size="sm" loading={busy(`st-${s.id}`)} onClick={() => run(() => setSectionStatusAction(brandId, profileId, s.id, "needs_review"), { key: `st-${s.id}`, success: "Section reopened for review" })}>
                          <RotateCcw /> Reopen
                        </Button>
                      ) : (
                        <Button variant="accent" size="sm" loading={busy(`st-${s.id}`)} disabled={editing !== null} onClick={() => run(() => setSectionStatusAction(brandId, profileId, s.id, "confirmed"), { key: `st-${s.id}`, success: `${s.label} confirmed and saved to brand memory` })}>
                          <Check /> Confirm
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <div className="p-5">
              {s.id === "identity" ? <Identity p={p} edit={isEditing} set={setDraft} /> : null}
              {s.id === "audience" ? <Audience p={p} edit={isEditing} set={setDraft} /> : null}
              {s.id === "communication" ? <Communication p={p} edit={isEditing} set={setDraft} /> : null}
              {s.id === "visual" ? <Visual p={p} edit={isEditing} set={setDraft} /> : null}
              {s.id === "marketing" ? <Marketing p={p} edit={isEditing} set={setDraft} /> : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

type SecProps = { p: BrandProfileV2; edit: boolean; set: React.Dispatch<React.SetStateAction<BrandProfileV2>> };

// ---------------------------------------------------------------------------
// A. Identity
// ---------------------------------------------------------------------------

function Identity({ p, edit, set }: SecProps) {
  const id = p.identity;
  const up = (patch: Partial<BrandProfileV2["identity"]>) => set((d) => ({ ...d, identity: { ...d.identity, ...patch } }));
  if (edit) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label>Positioning statement</Label>
          <Textarea
            value={id.positioning.statement}
            onChange={(e) => up({ positioning: { ...id.positioning, statement: e.target.value, source: "provided", evidence: EDITED } })}
          />
        </div>
        <div>
          <Label>Category</Label>
          <Input value={id.positioning.category} onChange={(e) => up({ positioning: { ...id.positioning, category: e.target.value } })} />
        </div>
        <div>
          <Label>Archetype</Label>
          <Input value={id.archetype} onChange={(e) => up({ archetype: e.target.value })} />
        </div>
        <ListEditor label="Personality traits" value={id.personality.map((f) => f.text).join("\n")} onChange={(v) => up({ personality: linesToFindings(id.personality, v) })} />
        <ListEditor label="Brand values" value={id.values.map((f) => f.text).join("\n")} onChange={(v) => up({ values: linesToFindings(id.values, v) })} />
        <ListEditor label="Unique selling propositions" value={id.usps.map((f) => f.text).join("\n")} onChange={(v) => up({ usps: linesToFindings(id.usps, v) })} />
        <ListEditor label="Competitive differentiation" value={id.differentiation.map((f) => f.text).join("\n")} onChange={(v) => up({ differentiation: linesToFindings(id.differentiation, v) })} />
      </div>
    );
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="md:col-span-2">
        <Label>Positioning {id.positioning.category ? `· ${id.positioning.category}` : ""}</Label>
        {id.positioning.statement ? (
          <div className="flex flex-wrap items-start gap-2">
            <p className="min-w-0 flex-1 font-display text-[22px] leading-snug">{id.positioning.statement}</p>
            <SourceChip source={id.positioning.source} evidence={id.positioning.evidence} />
          </div>
        ) : (
          <p className="text-[13px] text-faint">Not determined</p>
        )}
      </div>
      <div>
        <Label>Personality {id.archetype ? `· ${id.archetype}` : ""}</Label>
        <FindingList items={id.personality} />
      </div>
      <div>
        <Label>Brand values</Label>
        <FindingList items={id.values} />
      </div>
      <div>
        <Label>Unique selling propositions</Label>
        <FindingList items={id.usps} />
      </div>
      <div>
        <Label>Competitive differentiation</Label>
        <FindingList items={id.differentiation} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. Audience
// ---------------------------------------------------------------------------

function Audience({ p, edit, set }: SecProps) {
  const a = p.audience;
  const up = (patch: Partial<BrandProfileV2["audience"]>) => set((d) => ({ ...d, audience: { ...d.audience, ...patch } }));
  const upPersona = (i: number, patch: Partial<BrandProfileV2["audience"]["personas"][number]>) =>
    up({ personas: a.personas.map((x, j) => (j === i ? { ...x, ...patch, source: "provided" } : x)) });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {a.personas.map((x, i) =>
          edit ? (
            <div key={i} className="space-y-2 rounded-xl border border-line p-4">
              <div className="flex gap-2">
                <Input value={x.name} onChange={(e) => upPersona(i, { name: e.target.value })} placeholder="Persona name" />
                <Button variant="ghost" size="icon" onClick={() => up({ personas: a.personas.filter((_, j) => j !== i) })} aria-label="Remove persona">
                  <Trash2 />
                </Button>
              </div>
              <Textarea rows={2} value={x.snapshot} onChange={(e) => upPersona(i, { snapshot: e.target.value })} placeholder="Snapshot" />
              <Input value={x.demographics} onChange={(e) => upPersona(i, { demographics: e.target.value })} placeholder="Demographics" />
              <Input value={x.interests.join(", ")} onChange={(e) => upPersona(i, { interests: csv(e.target.value) })} placeholder="Interests, comma separated" />
              <Input value={x.painPoints.join(", ")} onChange={(e) => upPersona(i, { painPoints: csv(e.target.value) })} placeholder="Pain points, comma separated" />
              <Input value={x.motivations.join(", ")} onChange={(e) => upPersona(i, { motivations: csv(e.target.value) })} placeholder="Buying motivations, comma separated" />
            </div>
          ) : (
            <div key={i} className="rounded-xl border border-line p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{x.name}</p>
                <SourceChip source={x.source} />
              </div>
              <p className="mt-1 text-[13px] text-muted">{x.snapshot}</p>
              <p className="mt-2 text-[12px]">
                <span className="text-faint">Demographics: </span>
                {x.demographics || "Not specified"}
              </p>
              {[
                ["Interests", x.interests],
                ["Pain points", x.painPoints],
                ["Motivations", x.motivations],
              ].map(([l, items]) =>
                (items as string[]).length ? (
                  <div key={l as string} className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{l as string}</p>
                    <p className="text-[12px] text-ink-2">{(items as string[]).join(" · ")}</p>
                  </div>
                ) : null,
              )}
            </div>
          ),
        )}
        {edit ? (
          <button
            type="button"
            onClick={() => up({ personas: [...a.personas, { name: "New persona", snapshot: "", demographics: "Not specified", interests: [], painPoints: [], motivations: [], channels: [], source: "provided" }] })}
            className="grid min-h-32 place-items-center rounded-xl border border-dashed border-line-strong text-[13px] text-muted hover:bg-sunken/40"
          >
            <span className="flex items-center gap-1.5">
              <Plus className="size-4" /> Add persona
            </span>
          </button>
        ) : null}
        {!edit && !a.personas.length ? <p className="text-[13px] text-faint">No personas yet</p> : null}
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {edit ? (
          <>
            <ListEditor label="Customer interests" value={a.interests.map((f) => f.text).join("\n")} onChange={(v) => up({ interests: linesToFindings(a.interests, v) })} />
            <ListEditor label="Pain points" value={a.painPoints.map((f) => f.text).join("\n")} onChange={(v) => up({ painPoints: linesToFindings(a.painPoints, v) })} />
            <ListEditor label="Buying motivations" value={a.motivations.map((f) => f.text).join("\n")} onChange={(v) => up({ motivations: linesToFindings(a.motivations, v) })} />
          </>
        ) : (
          <>
            <div>
              <Label>Customer interests</Label>
              <FindingList items={a.interests} />
            </div>
            <div>
              <Label>Pain points</Label>
              <FindingList items={a.painPoints} />
            </div>
            <div>
              <Label>Buying motivations</Label>
              <FindingList items={a.motivations} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C. Communication
// ---------------------------------------------------------------------------

function Communication({ p, edit, set }: SecProps) {
  const c = p.communication;
  const up = (patch: Partial<BrandProfileV2["communication"]>) => set((d) => ({ ...d, communication: { ...d.communication, ...patch } }));
  const lines = (xs: string[]) => xs.join("\n");
  const fromLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  if (edit) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {(["voice", "tone", "style"] as const).map((k) => (
          <div key={k}>
            <Label>{k === "voice" ? "Brand voice" : k === "tone" ? "Tone" : "Communication style"}</Label>
            <Textarea value={c[k].text} onChange={(e) => up({ [k]: editOne(c[k], e.target.value) })} />
          </div>
        ))}
        <ListEditor label="Preferred vocabulary" value={lines(c.vocabulary)} onChange={(v) => up({ vocabulary: fromLines(v) })} />
        <ListEditor label="Words & expressions to avoid" value={lines(c.avoid)} onChange={(v) => up({ avoid: fromLines(v) })} />
        <ListEditor label="Sample lines" value={lines(c.sampleLines)} onChange={(v) => up({ sampleLines: fromLines(v) })} />
        <ListEditor label="Do" value={lines(c.do)} onChange={(v) => up({ do: fromLines(v) })} />
        <ListEditor label="Don't" value={lines(c.dont)} onChange={(v) => up({ dont: fromLines(v) })} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-3">
        <div>
          <Label>Brand voice</Label>
          <OneFinding f={c.voice} />
        </div>
        <div>
          <Label>Tone</Label>
          <OneFinding f={c.tone} />
        </div>
        <div>
          <Label>Communication style</Label>
          <OneFinding f={c.style} />
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Label>Preferred vocabulary</Label>
          <Chips items={c.vocabulary} />
        </div>
        <div>
          <Label>Words & expressions to avoid</Label>
          {c.avoid.length ? (
            <div className="flex flex-wrap gap-1.5">
              {c.avoid.map((w) => (
                <span key={w} className="rounded-full bg-danger-soft px-2.5 py-0.5 text-[12px] text-danger line-through decoration-danger/40">
                  {w}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-faint">None yet</p>
          )}
        </div>
        <div>
          <Label>Do</Label>
          <ul className="space-y-1 text-[13px]">{c.do.map((x) => <li key={x}>✓ {x}</li>)}</ul>
        </div>
        <div>
          <Label>Don&apos;t</Label>
          <ul className="space-y-1 text-[13px]">{c.dont.map((x) => <li key={x}>✕ {x}</li>)}</ul>
        </div>
      </div>
      {c.sampleLines.length ? (
        <div>
          <Label>Sounds like</Label>
          <div className="space-y-1.5">
            {c.sampleLines.map((l) => (
              <p key={l} className="border-l-2 border-accent/40 pl-3 font-display text-[18px] italic text-ink-2">
                “{l}”
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// D. Visual identity
// ---------------------------------------------------------------------------

const ROLES = ["primary", "secondary", "accent", "neutral", "background"] as const;

function Visual({ p, edit, set }: SecProps) {
  const v = p.visual;
  const up = (patch: Partial<BrandProfileV2["visual"]>) => set((d) => ({ ...d, visual: { ...d.visual, ...patch } }));
  const upColor = (i: number, patch: Partial<BrandProfileV2["visual"]["palette"][number]>) =>
    up({ palette: v.palette.map((c, j) => (j === i ? { ...c, ...patch, source: "provided" } : c)) });
  const validHex = (h: string) => /^#[0-9a-f]{6}$/i.test(h);

  return (
    <div className="space-y-6">
      <div>
        <Label>Colour palette</Label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {v.palette.map((c, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-line">
              <div className="relative h-16" style={{ background: validHex(c.hex) ? c.hex : "#eee" }}>
                {edit ? (
                  <input type="color" value={validHex(c.hex) ? c.hex : "#000000"} onChange={(e) => upColor(i, { hex: e.target.value.toUpperCase() })} className="absolute inset-0 size-full cursor-pointer opacity-0" aria-label="Pick colour" />
                ) : null}
              </div>
              <div className="space-y-1 p-2.5">
                {edit ? (
                  <>
                    <Input value={c.hex} onChange={(e) => upColor(i, { hex: e.target.value })} className="h-7 font-mono text-[12px]" />
                    <Input value={c.name} onChange={(e) => upColor(i, { name: e.target.value })} className="h-7 text-[12px]" placeholder="Name" />
                    <Select value={c.role} onChange={(e) => upColor(i, { role: e.target.value as (typeof ROLES)[number] })} className="h-7 text-[12px]">
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                    <button type="button" onClick={() => up({ palette: v.palette.filter((_, j) => j !== i) })} className="text-[11px] text-faint hover:text-danger">
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-1">
                      <p className="font-mono text-[12px] uppercase">{c.hex}</p>
                      <SourceChip source={c.source} />
                    </div>
                    <p className="text-[12px] font-medium">{c.name}</p>
                    <p className="text-[11px] capitalize text-muted">
                      {c.role}
                      {c.usage ? ` · ${c.usage}` : ""}
                    </p>
                  </>
                )}
              </div>
            </div>
          ))}
          {edit && v.palette.length < 8 ? (
            <button
              type="button"
              onClick={() => up({ palette: [...v.palette, { hex: "#B08D57", name: "New colour", role: "accent", usage: "", source: "provided" }] })}
              className="grid min-h-28 place-items-center rounded-xl border border-dashed border-line-strong text-[12px] text-muted hover:bg-sunken/40"
            >
              <span className="flex items-center gap-1">
                <Plus className="size-3.5" /> Add colour
              </span>
            </button>
          ) : null}
          {!edit && !v.palette.length ? <p className="text-[13px] text-faint">No colours yet</p> : null}
        </div>
      </div>

      {edit ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>Heading typeface</Label>
            <Input value={v.typography.heading} onChange={(e) => up({ typography: { ...v.typography, heading: e.target.value, source: "provided" } })} />
          </div>
          <div>
            <Label>Body typeface</Label>
            <Input value={v.typography.body} onChange={(e) => up({ typography: { ...v.typography, body: e.target.value, source: "provided" } })} />
          </div>
          <div className="md:col-span-2">
            <Label>Typography characteristics</Label>
            <Input value={v.typography.characteristics} onChange={(e) => up({ typography: { ...v.typography, characteristics: e.target.value, source: "provided" } })} />
          </div>
          <div>
            <Label>Image aesthetics</Label>
            <Textarea value={v.imagery.text} onChange={(e) => up({ imagery: editOne(v.imagery, e.target.value) })} />
          </div>
          <div>
            <Label>Logo usage guidelines</Label>
            <Textarea value={v.logoUsage.text} onChange={(e) => up({ logoUsage: editOne(v.logoUsage, e.target.value) })} />
          </div>
          <ListEditor label="Design preferences" value={v.designPreferences.map((f) => f.text).join("\n")} onChange={(x) => up({ designPreferences: linesToFindings(v.designPreferences, x) })} />
          <div>
            <Label>Creative direction</Label>
            <Textarea rows={4} value={v.creativeDirection} onChange={(e) => up({ creativeDirection: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <Label>Preferred creative styles</Label>
            <div className="flex flex-wrap gap-1.5">
              {STYLES.map((s) => {
                const on = v.preferredStyles.includes(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => up({ preferredStyles: on ? v.preferredStyles.filter((x) => x !== s.id) : [...v.preferredStyles, s.id] })} className={cn("rounded-full border px-2.5 py-1 text-[12px]", on ? "border-ink bg-ink text-white" : "border-line")}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Label>Typography</Label>
            </div>
            <div className="flex flex-wrap items-start gap-2 text-[13px]">
              <div className="min-w-0 flex-1">
                <p>
                  <span className="text-faint">Headings: </span>
                  {v.typography.heading || "—"}
                </p>
                <p>
                  <span className="text-faint">Body: </span>
                  {v.typography.body || "—"}
                </p>
                {v.typography.characteristics ? <p className="mt-1 text-muted">{v.typography.characteristics}</p> : null}
              </div>
              <SourceChip source={v.typography.source} />
            </div>
          </div>
          <div>
            <Label>Image aesthetics</Label>
            <OneFinding f={v.imagery} />
          </div>
          <div>
            <Label>Design preferences</Label>
            <FindingList items={v.designPreferences} />
          </div>
          <div>
            <Label>Logo usage</Label>
            <OneFinding f={v.logoUsage} />
          </div>
          {v.creativeDirection ? (
            <div className="md:col-span-2">
              <Label>Creative direction</Label>
              <p className="rounded-xl bg-sunken/60 p-4 text-[13px] leading-relaxed">{v.creativeDirection}</p>
            </div>
          ) : null}
          <div className="md:col-span-2">
            <Label>Preferred creative styles</Label>
            <Chips items={v.preferredStyles.map((s) => styleById(s).label)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// E. Marketing intelligence
// ---------------------------------------------------------------------------

function pairs<T extends { source: Source }>(prev: T[], text: string, make: (a: string, b: string) => Omit<T, "source">, key: (x: T) => string): T[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const existing = prev.find((x) => key(x) === line);
      if (existing) return existing;
      const [a, ...rest] = line.split(":");
      return { ...make(a.trim(), rest.join(":").trim()), source: "provided" } as T;
    });
}

function Marketing({ p, edit, set }: SecProps) {
  const m = p.marketing;
  const up = (patch: Partial<BrandProfileV2["marketing"]>) => set((d) => ({ ...d, marketing: { ...d.marketing, ...patch } }));
  const pillarKey = (x: { name: string; description: string }) => (x.description ? `${x.name}: ${x.description}` : x.name);
  const oppKey = (x: { title: string; why: string }) => (x.why ? `${x.title}: ${x.why}` : x.title);

  if (edit) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <ListEditor label="Marketing objectives" value={m.objectives.map((f) => f.text).join("\n")} onChange={(v) => up({ objectives: linesToFindings(m.objectives, v) })} />
        <ListEditor
          label="Content pillars (Name: description)"
          value={m.contentPillars.map(pillarKey).join("\n")}
          onChange={(v) => up({ contentPillars: pairs(m.contentPillars, v, (name, description) => ({ name, description }), pillarKey) })}
        />
        <ListEditor
          label="Campaign opportunities (Title: why)"
          value={m.campaignOpportunities.map(oppKey).join("\n")}
          onChange={(v) => up({ campaignOpportunities: pairs(m.campaignOpportunities, v, (title, why) => ({ title, why }), oppKey) })}
        />
        <ListEditor
          label="Content opportunities (Title: why)"
          value={m.contentOpportunities.map(oppKey).join("\n")}
          onChange={(v) => up({ contentOpportunities: pairs(m.contentOpportunities, v, (title, why) => ({ title, why }), oppKey) })}
        />
        <div className="md:col-span-2">
          <Label>Platform recommendations</Label>
          <div className="space-y-2">
            {m.platforms.map((x, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_1fr_auto]">
                <Select value={x.platform} onChange={(e) => up({ platforms: m.platforms.map((y, j) => (j === i ? { ...y, platform: e.target.value as typeof y.platform, source: "provided" } : y)) })}>
                  {PLATFORMS.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.label}
                    </option>
                  ))}
                </Select>
                <Input value={x.role} placeholder="Role" onChange={(e) => up({ platforms: m.platforms.map((y, j) => (j === i ? { ...y, role: e.target.value, source: "provided" } : y)) })} />
                <Input value={x.why} placeholder="Why" onChange={(e) => up({ platforms: m.platforms.map((y, j) => (j === i ? { ...y, why: e.target.value, source: "provided" } : y)) })} />
                <Button variant="ghost" size="icon" onClick={() => up({ platforms: m.platforms.filter((_, j) => j !== i) })} aria-label="Remove platform">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => up({ platforms: [...m.platforms, { platform: "instagram", role: "", why: "", source: "provided" }] })}>
              <Plus /> Add platform
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Label>Marketing objectives</Label>
          <FindingList items={m.objectives} />
        </div>
        <div>
          <Label>Platform recommendations</Label>
          {m.platforms.length ? (
            <ul className="space-y-2">
              {m.platforms.map((x, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="w-24 shrink-0 font-medium">{platformLabel(x.platform)}</span>
                  <span className="min-w-0 flex-1 text-ink-2">
                    {x.role}
                    {x.why ? <span className="text-muted"> · {x.why}</span> : null}
                  </span>
                  <SourceChip source={x.source} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-faint">Nothing yet</p>
          )}
        </div>
      </div>
      <div>
        <Label>Recommended content pillars</Label>
        {m.contentPillars.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {m.contentPillars.map((x, i) => (
              <div key={i} className="rounded-xl border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[13px] font-medium">{x.name}</p>
                  <SourceChip source={x.source} />
                </div>
                <p className="mt-1 text-[12px] text-muted">{x.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-faint">Nothing yet</p>
        )}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {[
          ["Campaign opportunities", m.campaignOpportunities],
          ["Content opportunities", m.contentOpportunities],
        ].map(([label, items]) => (
          <div key={label as string}>
            <Label>{label as string}</Label>
            {(items as { title: string; why: string; source: Source }[]).length ? (
              <ul className="space-y-2">
                {(items as { title: string; why: string; source: Source }[]).map((x, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{x.title}</p>
                      <p className="text-[12px] text-muted">{x.why}</p>
                    </div>
                    <SourceChip source={x.source} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-faint">Nothing yet</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
