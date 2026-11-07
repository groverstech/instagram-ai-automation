"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Plus, Sparkles, Upload, X } from "lucide-react";
import { createBrand, runBrandIntelligence } from "@/app/actions/brand";
import { Button, Field, Input, Notice, Textarea } from "@/components/ui";
import { OBJECTIVES, PLATFORMS, objectiveLabel } from "@/lib/domain";
import { cn } from "@/lib/utils";

const STEPS = ["Business", "Audience", "Identity", "Goals", "Competitors", "Visuals", "Review"] as const;

const TONE_CHIPS = ["Warm", "Witty", "Authoritative", "Playful", "Minimal", "Bold", "Empathetic", "Luxurious", "Technical", "Inspiring"];

const UPLOADS = [
  { kind: "logo", label: "Logo", hint: "PNG or SVG with transparency works best" },
  { kind: "guideline", label: "Brand guidelines", hint: "PDF or images" },
  { kind: "product", label: "Product photography", hint: "Your best product shots" },
  { kind: "creative", label: "Existing marketing creatives", hint: "Ads, banners, posters" },
  { kind: "post", label: "Previous social posts", hint: "Screenshots or exports" },
  { kind: "reference", label: "Reference designs", hint: "Work you admire" },
] as const;

export function OnboardingWizard({ userName }: { userName: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0);
  const [colors, setColors] = useState<string[]>(["#1F1D1A", "#F4EFE8"]);
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [phase, setPhase] = useState<"form" | "saving" | "analyzing">("form");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const next = () => {
    if (step === 0 && !name.trim()) return setError("Add your brand name to continue.");
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  async function submit() {
    if (!formRef.current) return;
    setError(null);
    const fd = new FormData(formRef.current);
    fd.set("colors", colors.join(","));
    for (const [kind, list] of Object.entries(files)) for (const f of list) fd.append(`asset_${kind}`, f);
    setPhase("saving");
    const created = await createBrand(fd);
    if (!created.ok) {
      setPhase("form");
      return setError(created.error);
    }
    setPhase("analyzing");
    const analyzed = await runBrandIntelligence(created.data.brandId);
    if (!analyzed.ok) {
      // The brand is saved; send them to the brand page where they can retry analysis.
      router.push(`/brand?analysisError=${encodeURIComponent(analyzed.error)}`);
      return;
    }
    router.push("/brand?fresh=1");
  }

  if (phase !== "form") return <Analyzing phase={phase} />;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
            <Sparkles className="size-4" />
          </span>
          BrandPilot
        </div>
        <ol className="hidden items-center gap-1 md:flex">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition",
                  i === step ? "bg-ink text-white" : i < step ? "text-ink hover:bg-sunken" : "text-faint",
                )}
              >
                <span className={cn("grid size-4 place-items-center rounded-full text-[10px]", i < step ? "bg-success text-white" : "")}>{i < step ? <Check className="size-3" /> : i + 1}</span>
                {s}
              </button>
              {i < STEPS.length - 1 ? <span className="h-px w-3 bg-line-strong" /> : null}
            </li>
          ))}
        </ol>
      </header>

      <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="mx-auto max-w-2xl px-6 pb-24 pt-6 md:pt-12">
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
            <StepIntro step={step} userName={userName} />
          </motion.div>
        </AnimatePresence>

        {/* All steps stay mounted so the single form submits every field. */}
        <div className="mt-8 space-y-5">
          <Section show={step === 0}>
            <Field label="Brand or business name">
              <Input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kora Ceramics" autoFocus />
            </Field>
            <Field label="Website" hint="We'll read it to learn your story">
              <Input name="website" placeholder="https://kora.studio" />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Industry">
                <Input name="industry" placeholder="Home & lifestyle" />
              </Field>
              <Field label="Category">
                <Input name="category" placeholder="Handmade ceramics" />
              </Field>
            </div>
            <Field label="Products and services">
              <Textarea name="products" placeholder="Stoneware mugs, serving bowls, made-to-order dinner sets, pottery workshops" />
            </Field>
          </Section>

          <Section show={step === 1}>
            <Field label="Who is your target audience?" hint="Be specific: who they are, what they care about">
              <Textarea name="targetAudience" rows={4} placeholder="Design-conscious homeowners aged 28–45 who prefer fewer, better things and enjoy hosting." />
            </Field>
            <Field label="Geographic market">
              <Input name="geography" placeholder="India — Mumbai, Bengaluru, Delhi; ships nationwide" />
            </Field>
          </Section>

          <Section show={step === 2}>
            <Field label="Brand positioning" hint="How you want to be seen vs. alternatives">
              <Textarea name="positioning" placeholder="The modern heirloom: handmade ceramics designed for everyday use, priced below gallery pieces." />
            </Field>
            <Field label="Brand personality">
              <Input name="personality" placeholder="Calm, crafted, quietly confident" />
            </Field>
            <ToneField />
          </Section>

          <Section show={step === 3}>
            <ChipGroup name="objectives" label="Main business objectives" options={OBJECTIVES.map((o) => ({ value: o, label: objectiveLabel(o) }))} defaults={["awareness", "sales"]} />
            <Field label="Marketing goals" hint="Numbers help the strategist">
              <Textarea name="marketingGoals" placeholder="Grow Instagram from 8k to 15k by March, 40 workshop sign-ups/month, launch the winter glaze collection." />
            </Field>
            <ChipGroup name="platforms" label="Preferred platforms" options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))} defaults={["instagram"]} />
          </Section>

          <Section show={step === 4}>
            <Field label="Competitors" hint="Names or profile URLs, one per line">
              <Textarea name="competitors" rows={5} placeholder={"Claymen\nhttps://www.instagram.com/someclaystudio\nThe Pottery Barn"} />
            </Field>
            <p className="text-[13px] text-muted">The Competitor Research agent studies only publicly available information.</p>
          </Section>

          <Section show={step === 5}>
            <div>
              <p className="mb-2 text-[12px] font-medium text-ink-2">Brand colour palette</p>
              <div className="flex flex-wrap items-center gap-2">
                {colors.map((c, i) => (
                  <div key={i} className="group flex items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-1.5 pr-2">
                    <input
                      type="color"
                      value={c}
                      onChange={(e) => setColors((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))}
                      className="size-7 cursor-pointer rounded-lg border-0 bg-transparent p-0"
                      aria-label={`Colour ${i + 1}`}
                    />
                    <span className="font-mono text-[12px] uppercase text-ink-2">{c}</span>
                    <button type="button" onClick={() => setColors((cs) => cs.filter((_, j) => j !== i))} className="text-faint opacity-0 transition group-hover:opacity-100" aria-label="Remove colour">
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                {colors.length < 6 ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setColors((cs) => [...cs, "#B08D57"])}>
                    <Plus /> Add colour
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Heading font" hint="Any Google Font">
                <Input name="headingFont" placeholder="Playfair Display" />
              </Field>
              <Field label="Body font">
                <Input name="bodyFont" placeholder="Inter" />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {UPLOADS.map((u) => (
                <Dropzone key={u.kind} label={u.label} hint={u.hint} files={files[u.kind] ?? []} onChange={(list) => setFiles((f) => ({ ...f, [u.kind]: list }))} />
              ))}
            </div>
          </Section>

          <Section show={step === 6}>
            <div className="rounded-2xl border border-line bg-surface p-6">
              <p className="font-medium">Ready to build {name || "your brand"}&apos;s intelligence profile</p>
              <ul className="mt-4 space-y-2.5 text-[13px] text-ink-2">
                {[
                  "Reads your website and onboarding answers",
                  "Analyses your logo, guidelines and imagery with vision",
                  "Identifies positioning, USPs, personas, voice and visual identity",
                  "Saves it as brand memory every other agent uses",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 text-success" />
                    {t}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[13px] text-muted">You&apos;ll review and edit everything before approving it.</p>
            </div>
          </Section>
        </div>

        {error ? <Notice tone="danger" className="mt-6">{error}</Notice> : null}

        <div className="mt-10 flex items-center justify-between">
          <Button type="button" variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            <ArrowLeft /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <div className="flex gap-2">
              {step > 0 && step < 6 ? (
                <Button type="button" variant="ghost" onClick={next}>
                  Skip
                </Button>
              ) : null}
              <Button type="button" onClick={next}>
                Continue <ArrowRight />
              </Button>
            </div>
          ) : (
            <Button type="button" variant="accent" size="lg" onClick={submit}>
              <Sparkles /> Analyse my brand
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function Section({ show, children }: { show: boolean; children: React.ReactNode }) {
  return <div className={cn("space-y-5", !show && "hidden")}>{children}</div>;
}

function StepIntro({ step, userName }: { step: number; userName: string }) {
  const copy = [
    [`Hi ${userName}, let's get to know your brand`, "Your answers become the foundation your AI team works from. The more specific, the better."],
    ["Who are you talking to?", "Audience and market shape tone, timing, cultural moments and platforms."],
    ["How should your brand feel?", "Positioning and voice keep every caption sounding like you."],
    ["What should marketing achieve?", "Objectives drive what the strategist prioritises and what analytics measures."],
    ["Who else is in the room?", "We'll find the gaps your competitors leave open."],
    ["Show us your visual identity", "Logos, guidelines and past work teach the Creative Director your aesthetic."],
    ["Let your AI team study the brand", "This takes about a minute."],
  ][step];
  return (
    <div>
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-faint">Step {step + 1} of {STEPS.length}</p>
      <h1 className="mt-2 font-display text-[40px] leading-[1.08]">{copy[0]}</h1>
      <p className="mt-3 text-[15px] text-muted">{copy[1]}</p>
    </div>
  );
}

function ToneField() {
  const [tone, setTone] = useState("");
  return (
    <Field label="Tone of voice">
      <Textarea name="tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Warm and precise. Short sentences. Never salesy." />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {TONE_CHIPS.map((t) => (
          <button key={t} type="button" onClick={() => setTone((v) => (v ? `${v.replace(/[.\s]*$/, "")}, ${t.toLowerCase()}` : t))} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 transition hover:border-ink/30 hover:bg-surface">
            + {t}
          </button>
        ))}
      </div>
    </Field>
  );
}

function ChipGroup({ name, label, options, defaults }: { name: string; label: string; options: { value: string; label: string }[]; defaults: string[] }) {
  const [sel, setSel] = useState<string[]>(defaults);
  return (
    <div>
      <p className="mb-2 text-[12px] font-medium text-ink-2">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = sel.includes(o.value);
          return (
            <label key={o.value} className={cn("cursor-pointer select-none rounded-xl border px-3.5 py-2 text-[13px] transition", on ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>
              <input type="checkbox" name={name} value={o.value} checked={on} onChange={() => setSel((s) => (on ? s.filter((x) => x !== o.value) : [...s, o.value]))} className="sr-only" />
              {o.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Dropzone({ label, hint, files, onChange }: { label: string; hint: string; files: File[]; onChange: (f: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onChange([...files, ...Array.from(e.dataTransfer.files)]);
      }}
      onClick={() => ref.current?.click()}
      className={cn("cursor-pointer rounded-xl border border-dashed p-4 transition", over ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:bg-sunken/40")}
    >
      <input ref={ref} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => onChange([...files, ...Array.from(e.target.files ?? [])])} />
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-sunken text-muted">
          <Upload className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{label}</p>
          <p className="truncate text-[12px] text-faint">{files.length ? files.map((f) => f.name).join(", ") : hint}</p>
        </div>
        {files.length ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="ml-auto text-faint hover:text-ink"
            aria-label="Clear files"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Analyzing({ phase }: { phase: "saving" | "analyzing" }) {
  const steps = ["Saving brand & uploads", "Reading your website", "Analysing visual assets", "Mapping positioning & personas", "Defining voice & visual identity"];
  return (
    <div className="grid min-h-screen place-items-center ai-gradient p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/70 bg-white/80 p-8 shadow-pop backdrop-blur">
        <div className="relative mx-auto mb-6 size-14">
          <div className="absolute inset-0 animate-spin rounded-full ai-ring [animation-duration:3s]" />
          <div className="absolute inset-[3px] grid place-items-center rounded-full bg-white">
            <Sparkles className="size-5 text-accent" />
          </div>
        </div>
        <h2 className="text-center font-display text-[28px]">Studying your brand</h2>
        <p className="mt-1 text-center text-[13px] text-muted">The Brand Intelligence agent is building your profile.</p>
        <ul className="mt-6 space-y-2">
          {steps.map((s, i) => (
            <motion.li
              key={s}
              initial={{ opacity: 0.3 }}
              animate={{ opacity: phase === "saving" && i > 0 ? 0.3 : 1 }}
              transition={{ delay: phase === "analyzing" ? i * 2.5 : 0 }}
              className="flex items-center gap-2 text-[13px]"
            >
              <span className="size-1.5 rounded-full bg-accent" />
              {s}
            </motion.li>
          ))}
        </ul>
      </div>
    </div>
  );
}
