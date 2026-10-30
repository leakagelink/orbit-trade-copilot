import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard, Bot, Cable, Blocks, Settings, LogOut, Moon, Sun, Menu, MessageSquareText, Activity,
  FlaskConical, ChartColumn, ShieldAlert, CandlestickChart, Wallet, Crown, Lock, ArrowLeftRight, Zap,
} from "lucide-react";
import { usePlan } from "@/hooks/use-plan";
import { canOpen, PLAN_FEATURES } from "@/lib/plans";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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
] as const;

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 font-mono text-sm font-semibold tracking-tight", className)}>
      <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <Activity className="h-4 w-4" />
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
  const pro = plan.data?.pro ?? false;
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = path === to || path.startsWith(to + "/");
        const locked = !plan.isLoading && !canOpen(to, pro);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", active && "text-sidebar-primary")} />
            {label}
            {locked && <Lock className="ml-auto h-3 w-3 text-muted-foreground" aria-label="Pro plan" />}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
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
    <div className="mt-auto space-y-2 border-t border-sidebar-border pt-3">
      <div className="truncate px-3 font-mono text-xs text-muted-foreground">{email}</div>
      <Button variant="ghost" size="sm" className="w-full justify-start gap-3" onClick={signOut}>
        <LogOut className="h-4 w-4" /> Sign out
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <div className="mb-6 flex items-center justify-between px-2 pt-1">
          <Logo />
          <ThemeToggle />
        </div>
        <NavLinks />
        {footer}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-64 flex-col bg-sidebar p-3">
              <div className="mb-6 px-2 pt-2"><Logo /></div>
              <NavLinks onNavigate={() => setOpen(false)} />
              {footer}
            </SheetContent>
          </Sheet>
          <Logo />
          <ThemeToggle />
        </header>
        <main className="flex-1"><PlanGate>{children}</PlanGate></main>
      </div>
    </div>
  );
}

/** Free plan: paid pages show an upgrade card instead of their content (the server enforces the same rule). */
function PlanGate({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const plan = usePlan();
  const free = canOpen(path, false);
  if (!free && plan.isLoading) return null;
  if (!free && !plan.data?.pro) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-lg bg-primary/15"><Crown className="h-6 w-6 text-primary" /></div>
        <h1 className="text-xl font-semibold tracking-tight">This is a Pro feature</h1>
        <p className="mt-2 text-sm text-muted-foreground">The Free plan includes manual trading and the wallet. Upgrade to Pro for:</p>
        <ul className="mx-auto mt-4 max-w-xs space-y-1 text-left text-sm">
          {PLAN_FEATURES.pro.features.slice(1).map((f) => <li key={f}>• {f}</li>)}
        </ul>
        <div className="mt-6 flex justify-center gap-2">
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
    <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: typeof Bot; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card/40 px-6 py-14 text-center">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-md bg-muted"><Icon className="h-5 w-5 text-muted-foreground" /></div>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
