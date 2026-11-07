"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  BarChart3,
  Brain,
  CalendarDays,
  ChevronsUpDown,
  Compass,
  LayoutDashboard,
  LogOut,
  Menu,
  Megaphone,
  Palette,
  PenLine,
  Plus,
  Radar,
  Settings,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import { switchBrand } from "@/app/actions/brand";
import { logOut } from "@/app/actions/auth";
import { cn, initials } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/brand", label: "My Brand", icon: Brain },
  { href: "/strategist", label: "AI Marketing Strategist", icon: Compass },
  { href: "/creative-studio", label: "Creative Studio", icon: Palette },
  { href: "/content-studio", label: "Content Studio", icon: PenLine },
  { href: "/campaigns", label: "Campaign Manager", icon: Megaphone },
  { href: "/calendar", label: "Content Calendar", icon: CalendarDays },
  { href: "/competitors", label: "Competitor Intelligence", icon: Radar },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/accounts", label: "Social Accounts", icon: Share2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

type SidebarProps = {
  brand: { id: string; name: string; colors: string[] };
  brands: { id: string; name: string }[];
  user: { name: string; email: string; role: string };
  pendingApprovals: number;
};

/** Desktop: fixed sidebar. Mobile: top bar with a slide-in drawer holding the same navigation. */
export function Sidebar(props: SidebarProps) {
  const [drawer, setDrawer] = useState(false);
  const path = usePathname();
  const current = NAV.find((n) => path === n.href || path.startsWith(`${n.href}/`));
  useEffect(() => {
    setDrawer(false);
  }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [drawer]);

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 border-r border-line bg-surface/70 backdrop-blur md:block">
        <SidebarPanel {...props} />
      </aside>

      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-3 backdrop-blur md:hidden" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <button onClick={() => setDrawer(true)} className="grid size-10 place-items-center rounded-lg text-ink hover:bg-sunken" aria-label="Open menu" aria-expanded={drawer}>
          <Menu className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{current?.label ?? "BrandPilot"}</span>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold text-white" style={{ background: props.brand.colors[0] ?? "#1b1a17" }} title={props.brand.name}>
          {initials(props.brand.name)}
        </span>
      </header>

      {drawer ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(300px,85vw)] bg-surface shadow-pop" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
            <button onClick={() => setDrawer(false)} className="absolute right-3 top-4 z-10 grid size-9 place-items-center rounded-lg text-muted hover:bg-sunken" aria-label="Close menu" style={{ marginTop: "env(safe-area-inset-top)" }}>
              <X className="size-5" />
            </button>
            <SidebarPanel {...props} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function SidebarPanel({ brand, brands, user, pendingApprovals, onNavigate }: SidebarProps & { onNavigate?: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 pb-4 pt-5 text-[15px] font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-white">
          <Sparkles className="size-3.5" />
        </span>
        BrandPilot
      </div>

      <div className="relative px-3">
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 py-2 text-left transition hover:border-line-strong">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[12px] font-semibold text-white" style={{ background: brand.colors[0] ?? "#1b1a17" }}>
            {initials(brand.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{brand.name}</span>
            <span className="block text-[11px] text-faint">{brands.length} brand{brands.length === 1 ? "" : "s"}</span>
          </span>
          <ChevronsUpDown className="size-4 text-faint" />
        </button>
        {open ? (
          <div className="absolute left-3 right-3 top-full z-30 mt-1 rounded-xl border border-line bg-surface p-1 shadow-pop">
            {brands.map((b) => (
              <button
                key={b.id}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await switchBrand(b.id);
                    setOpen(false);
                    router.refresh();
                  })
                }
                className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-sunken", b.id === brand.id && "bg-sunken font-medium")}
              >
                <span className="grid size-6 place-items-center rounded-md bg-ink/90 text-[10px] text-white">{initials(b.name)}</span>
                {b.name}
              </button>
            ))}
            <Link href="/onboarding" onClick={onNavigate} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-muted hover:bg-sunken hover:text-ink">
              <Plus className="size-4" /> Add brand
            </Link>
          </div>
        ) : null}
      </div>

      <nav className="scrollbar-thin mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = path === href || path.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition",
                active ? "bg-ink text-white shadow-sm" : "text-ink-2 hover:bg-sunken hover:text-ink",
              )}
            >
              <Icon className={cn("size-4", active ? "text-white" : "text-faint group-hover:text-ink-2")} />
              <span className="flex-1 truncate">{label}</span>
              {href === "/calendar" && pendingApprovals > 0 ? (
                <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", active ? "bg-white/20 text-white" : "bg-warn-soft text-warn")}>{pendingApprovals}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className="grid size-8 place-items-center rounded-full bg-sunken text-[11px] font-semibold text-ink-2">{initials(user.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{user.name}</p>
            <p className="truncate text-[11px] capitalize text-faint">{user.role}</p>
          </div>
          <form action={logOut}>
            <button className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink" aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
