import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard, Bot, Cable, Blocks, Settings, LogOut, Moon, Sun, Menu, MessageSquareText, Activity,
  FlaskConical, ChartColumn, ShieldAlert, CandlestickChart, Wallet, Crown, Lock, ArrowLeftRight, Zap, ChevronRight, ArrowUpRight, Ellipsis,
  Star, BookOpen, CalendarDays, Bell, LifeBuoy, HeartPulse,
} from "lucide-react";
import { usePlan } from "@/hooks/use-plan";
import { canOpen, requiredPlan, PLAN_FEATURES } from "@/lib/plans";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { MfaGate } from "@/components/mfa-gate";
import { recordSession } from "@/lib/security.functions";

const NAV = [
  { to: "/trade", label: "Trade", icon: CandlestickChart },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/assistant", label: "AI Assistant", icon: MessageSquareText },
  { to: "/strategies", label: "Strategies", icon: Blocks },
  { to: "/bots", label: "Trading Bots", icon: Bot },
  { to: "/scalping", label: "Scalping", icon: Zap },
  { to: "/arbitrage", label: "Arbitrage", icon: ArrowLeftRight },
  { to: "/backtests", label: "Backtests", icon: FlaskConical },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
  { to: "/risk", label: "Risk", icon: ShieldAlert },
  { to: "/exchanges", label: "Exchanges", icon: Cable },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/plans", label: "Plans", icon: Crown },
  { to: "/watchlist", label: "Watchlist & alerts", icon: Star },
  { to: "/journal", label: "Trading journal", icon: BookOpen },
  { to: "/calendar", label: "Economic calendar", icon: CalendarDays },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/support", label: "Support", icon: LifeBuoy },
  { to: "/status", label: "Service status", icon: HeartPulse },
] as const;

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5 font-sans text-lg font-bold", className)}>
      <span className="brand-mark grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
        <Activity className="h-5 w-5" />
      </span>
      QUANTRA
    </span>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      title="Toggle theme"
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("theme", next ? "dark" : "light");
      }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const plan = usePlan();
  const tier = plan.data?.plan ?? "free";
  return (
    <nav className="workspace-nav flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = path === to || path.startsWith(to + "/");
        const locked = !plan.isLoading && !canOpen(to, tier);
        const group = to === "/trade" ? "WORKSPACE" : to === "/assistant" ? "INTELLIGENCE" : to === "/backtests" ? "MANAGEMENT" : null;
        return (
          <div key={to}>
          {group && <div className="nav-label px-3 pb-2 pt-4 text-[10px] font-semibold text-muted-foreground">{group}</div>}
          <Link
            to={to}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "nav-link flex items-center gap-3 rounded-md px-3 py-2.5 text-[13px] transition-all",
              active ? "nav-active bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", active && "text-sidebar-primary")} />
            {label}
            {locked && <Lock className="ml-auto h-3 w-3 text-muted-foreground" aria-label={`${PLAN_FEATURES[requiredPlan(to)].name} plan`} />}
            {active && !locked && <ChevronRight className="ml-auto h-3 w-3 text-primary" />}
          </Link>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <MfaGate><SecuredShell>{children}</SecuredShell></MfaGate>;
}

function SecuredShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const plan = usePlan();
  const record = useServerFn(recordSession);
  useEffect(() => { record().catch(() => {}); const timer = setInterval(() => record().catch(() => {}), 60000); return () => clearInterval(timer); }, [record]);
  const unread = useQuery({queryKey:["notifications","unread"],enabled:plan.data?.pro===true,queryFn:async()=>{const r=await supabase.from("notifications").select("id",{count:"exact",head:true}).is("read_at",null);if(r.error)throw new Error("Notifications unavailable");return r.count??0;},refetchInterval:30000});
  const current = NAV.find(item => path === item.to || path.startsWith(item.to + "/"));
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const footer = (
    <div className="mt-auto space-y-2 border-t border-sidebar-border pt-4">
      <Link to="/plans" className="flex items-center justify-between rounded-md bg-secondary/70 px-3 py-2.5 text-xs">
        <span className="flex items-center gap-2"><Crown className="h-3.5 w-3.5 text-warning" />{PLAN_FEATURES[plan.data?.plan ?? "free"].name} workspace</span>
        <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
      </Link>
      <div className="truncate px-3 font-mono text-xs text-muted-foreground">{email}</div>
      <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={signOut}>
        <LogOut className="h-4 w-4" /> Sign out
      </Button>
    </div>
  );

  return (
    <div className="trading-workspace flex min-h-screen bg-background">
      <aside className="workspace-sidebar sticky top-0 hidden h-screen w-[224px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <div className="mb-1 flex items-center justify-between px-2 pt-3 pb-4">
          <Logo />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto"><NavLinks /></div>
        {footer}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="workspace-topbar grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 sm:flex sm:justify-between md:px-7">
          <div className="flex min-w-0 items-center gap-3">
          <div className="md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-64 flex-col overflow-y-auto bg-sidebar p-3">
              <div className="mb-6 px-2 pt-2"><Logo /></div>
              <NavLinks onNavigate={() => setOpen(false)} />
              {footer}
            </SheetContent>
          </Sheet>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">Workspace</span><ChevronRight className="hidden h-3 w-3 text-muted-foreground sm:inline" />
          <span className="truncate text-sm font-medium">{current?.label ?? "Workspace"}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
          <Link to="/wallet" className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><Wallet className="h-3.5 w-3.5" />Demo wallet</Link>
          <ThemeToggle />
          {plan.data?.pro && <Button variant="ghost" size="icon" asChild title="Notifications"><Link to="/notifications" aria-label="Notifications" className="relative"><Bell className="h-4 w-4"/>{(unread.data??0)>0&&<span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"/>}</Link></Button>}
          <span className="grid h-8 w-8 place-items-center rounded-full border bg-secondary font-mono text-xs" title="Your account">{email?.slice(0, 2).toUpperCase() ?? "Q"}</span>
          </div>
        </header>
        <main key={path} className="workspace-main min-w-0 flex-1"><PlanGate>{children}</PlanGate></main>
      </div>
      <nav aria-label="Mobile navigation" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t bg-sidebar md:hidden">
        {NAV.slice(0, 3).map(({ to, label, icon: Icon }) => {
          const active = path === to || path.startsWith(to + "/");
          const locked = !plan.isLoading && !canOpen(to, plan.data?.plan ?? "free");
          return (
            <Button key={to} variant="ghost" asChild className={cn("mobile-nav-item relative h-16 min-w-0 flex-col gap-1 rounded-none px-1 text-[10px]", active ? "text-primary" : "text-muted-foreground")}>
              <Link to={to} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                <span className="relative"><Icon className="h-5 w-5" />{locked && <Lock className="absolute -right-2 -top-1 h-2.5 w-2.5" aria-label="Pro plan" />}</span>
                <span>{label}</span>
              </Link>
            </Button>
          );
        })}
        <Button variant="ghost" aria-label="More" aria-expanded={open} onClick={() => setOpen(true)} className={cn("mobile-nav-item h-16 min-w-0 flex-col gap-1 rounded-none px-1 text-[10px]", open || !NAV.slice(0, 3).some(item => path === item.to) ? "text-primary" : "text-muted-foreground")}>
          <Ellipsis className="h-5 w-5" /><span>More</span>
        </Button>
      </nav>
    </div>
  );
}

/** Free plan: paid pages show an upgrade card instead of their content (the server enforces the same rule). */
function PlanGate({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const plan = usePlan();
  const free = canOpen(path, false);
  const needed = requiredPlan(path);
  if (!free && plan.isLoading) return null;
  if (!canOpen(path, plan.data?.plan ?? "free")) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-lg bg-primary/15"><Crown className="h-6 w-6 text-primary" /></div>
        <h1 className="text-xl font-semibold">This is an {PLAN_FEATURES[needed].name} feature</h1>
        <p className="mt-2 text-sm text-muted-foreground">Upgrade to {PLAN_FEATURES[needed].name} for:</p>
        <ul className="mx-auto mt-4 max-w-xs space-y-1 text-left text-sm">
          {PLAN_FEATURES[needed].features.slice(1).map((f) => <li key={f}>• {f}</li>)}
        </ul>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild><Link to="/plans">See plans</Link></Button>
          <Button variant="outline" asChild><Link to="/trade">Go to Trade</Link></Button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading flex flex-col gap-3 px-5 pb-5 pt-7 sm:flex-row sm:items-center sm:justify-between md:px-7">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold break-words">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="page-actions flex min-w-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: typeof Bot; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center border-y border-dashed px-6 py-14 text-center">
      <div className="empty-state-icon mb-4 grid h-14 w-14 place-items-center rounded-lg border bg-card"><Icon className="h-6 w-6 text-primary" /></div>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
