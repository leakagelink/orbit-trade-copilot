import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, Blocks, Cable, MessageSquareText, ShieldCheck, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo, ThemeToggle } from "@/components/app-shell";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Quantra — AI Algorithmic Trading Platform" },
      { name: "description", content: "Build, validate and automate crypto trading strategies with AI, paper trading and strict risk controls." },
      { property: "og:title", content: "Quantra — AI Algorithmic Trading Platform" },
      { property: "og:description", content: "Build, validate and automate crypto trading strategies with AI, paper trading and strict risk controls." },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  { icon: MessageSquareText, title: "AI assistant", body: "Describe an idea in plain language. Get a structured, editable strategy with risk parameters." },
  { icon: Blocks, title: "Strategy builder", body: "RSI, MACD, EMA, SMA, Bollinger, ATR, Stoch RSI and volume — with a validation engine before deploy." },
  { icon: Bot, title: "Trading bots", body: "Configure capital, sizing, exposure, stops and targets. Paper trade first, go live deliberately." },
  { icon: Cable, title: "Your exchange", body: "Connect Binance, Bybit, OKX and more. Keys are encrypted server-side; withdrawals never requested." },
  { icon: ShieldCheck, title: "Risk-first", body: "Every order passes position, exposure and daily-loss limits. The AI cannot override them." },
  { icon: LineChart, title: "Honest metrics", body: "PnL, win rate and drawdown computed from your actual trade records — never fabricated." },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" asChild><Link to="/auth">Sign in</Link></Button>
          <Button asChild><Link to="/auth" search={{ mode: "register" }}>Get started</Link></Button>
        </div>
      </header>
      <section className="relative overflow-hidden border-y bg-grid">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-20 lg:grid-cols-[1.2fr_1fr] lg:py-28">
          <div>
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-primary">Algorithmic trading · AI-assisted</p>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              Trade on rules,<br />not on impulse.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">
              Design strategies with AI, validate them, paper trade, then automate on your own exchange account — with risk controls on every order.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild><Link to="/auth" search={{ mode: "register" }}>Create free account</Link></Button>
              <Button size="lg" variant="outline" asChild><Link to="/auth">Sign in</Link></Button>
            </div>
          </div>
          <div className="rounded-lg border bg-card p-5 font-mono text-xs shadow-sm">
            <div className="mb-3 flex items-center justify-between text-muted-foreground"><span>strategy.json</span><span className="text-primary">● validated</span></div>
            <pre className="overflow-x-auto leading-relaxed text-card-foreground">{`{
  "pairs": ["BTC/USDT"],
  "timeframe": "4h",
  "entry": "ema_20 crosses_above ema_50",
  "filter": "rsi_14 < 65",
  "exit": "ema_20 crosses_below ema_50",
  "risk": {
    "stop_loss_pct": 2.5,
    "take_profit_pct": 6,
    "position_size_pct": 10,
    "daily_loss_limit_pct": 4
  }
}`}</pre>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-card p-6">
              <f.icon className="mb-4 h-5 w-5 text-primary" />
              <h3 className="font-medium">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t px-6 py-8 text-center text-xs text-muted-foreground">
        Trading cryptocurrencies involves substantial risk. Past performance does not guarantee future results.
      </footer>
    </div>
  );
}
