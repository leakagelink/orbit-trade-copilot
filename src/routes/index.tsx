import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, ArrowUpRight, ArrowLeftRight, Bot, Blocks, Cable, MessageSquareText, ShieldCheck, LineChart, CandlestickChart, Wallet, Zap, FlaskConical, Check, Plus, LockKeyhole, Menu, X, CircleCheck, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Logo, ThemeToggle } from "@/components/app-shell";
import { PLAN_FEATURES, PLAN_IDS, type BillingInterval } from "@/lib/plans";
import heroImage from "@/assets/home-trading.jpg";

const DESCRIPTION = "Trade crypto, forex and commodities with AlgoVirt. Start with free manual trading and a demo wallet, then explore AI, strategies, bots, backtesting, scalping and arbitrage.";
export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "AlgoVirt — Manual Trading, AI & Algorithmic Trading" },
    { name: "description", content: DESCRIPTION },
    { property: "og:title", content: "AlgoVirt — Your Complete Trading Workspace" },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: Landing,
});

const FEATURES = [
  { icon: CandlestickChart, title: "Manual trading", tier: "Free", body: "Buy, sell and close positions across crypto, forex and commodities. Set stop loss and take profit on your order." },
  { icon: Wallet, title: "A wallet for practice", tier: "Free", body: "Add and withdraw virtual USD, fund demo trades and track transactions. Practice without depositing real money." },
  { icon: MessageSquareText, title: "Your AI trading partner", tier: "Pro", body: "Explore market ideas, analyse indicators and turn a plain-language idea into an editable strategy. You confirm AI-assisted trades." },
  { icon: Blocks, title: "Strategies, built your way", tier: "Pro", body: "Combine RSI, MACD, EMA, SMA, Bollinger Bands, ATR, Stoch RSI and volume with entry, exit and risk rules." },
  { icon: Bot, title: "Rule-driven trading bots", tier: "Pro", body: "Choose a strategy, configure capital and position sizing, and run in paper mode before enabling supported live trading." },
  { icon: FlaskConical, title: "Backtest before committing", tier: "Pro", body: "Evaluate historical scenarios with fees and slippage. Compare returns, drawdown and win rate before deployment." },
  { icon: LineChart, title: "Performance with context", tier: "Pro", body: "Explore your dashboard and analytics by bot, strategy and market. Review net PnL, trade history and monthly performance." },
  { icon: Zap, title: "A dedicated scalping desk", tier: "Elite", body: "Short-timeframe charts, one-click orders and automatic stop, target and time-limit exits. Start from ready-made strategy templates." },
  { icon: ArrowLeftRight, title: "Cross-exchange arbitrage", tier: "Elite", body: "Compare order-book depth, fees and estimated net spreads. Get an AI review, simulate a run or confirm supported prefunded live legs." },
];
const MODES = [
  { id: "manual", label: "Manual", icon: CandlestickChart, title: "Your market. Your next move.", body: "Move from a TradingView lightweight chart to an order, then manage your open positions in the same workspace.", steps: ["Choose crypto, forex or commodities", "Set size, stop loss and take profit", "Buy or sell · close when you decide"], tier: "Free", market: "Crypto / Forex / Commodities" },
  { id: "ai", label: "AI & bots", icon: Bot, title: "Turn an idea into a repeatable process.", body: "Draft with AI, refine the rules, backtest your strategy and deploy a paper bot. Enable live trading only when you are ready.", steps: ["Draft & validate strategy rules", "Backtest with fees and slippage", "Paper bot → confirmed live mode"], tier: "Pro", market: "Strategy / Backtest / Deploy" },
  { id: "elite", label: "Scalp & arbitrage", icon: Zap, title: "More precision. More ways to trade.", body: "Use the scalping desk for short-duration positions or compare executable prices across supported crypto exchanges.", steps: ["Set a scalp bracket and time limit", "Review spreads after fees", "Confirm prefunded exchange legs"], tier: "Elite", market: "Scalping / Cross-exchange spot" },
] as const;
const FAQS = [
  ["What can I do on the Free plan?", "Manual buy/sell trading across supported crypto, forex and commodity markets, TradingView lightweight charts, stop loss/take profit, position closing and the virtual USD wallet. AI, strategies, bots, backtests and analytics require Pro; scalping and arbitrage require Elite."],
  ["Is the wallet real money?", "No. The wallet holds virtual USD for demo trading. Deposits and withdrawals only change your demo balance. AlgoVirt does not hold your real trading funds; live trades use your own connected exchange or broker account."],
  ["Can the AI place a trade without my approval?", "AI trade ideas and arbitrage reviews are advisory. You confirm AI-assisted manual trades and live arbitrage. Trading bots follow the strategy and mode you configure, with account risk checks; switching a bot to live requires explicit confirmation."],
  ["Which markets and exchanges are supported?", "Crypto market data includes Binance, Bybit, OKX, KuCoin and Coinbase. Supported live crypto order paths use Binance, Bybit, OKX and KuCoin. Forex and commodity demo prices use Yahoo Finance; supported live instruments use your OANDA account. Instrument and order availability varies by venue."],
  ["How does live arbitrage work?", "Elite live arbitrage currently supports Binance ↔ OKX spot. You need quote funds on the buy venue and crypto inventory on the sell venue. Orders are not atomic: either leg can fail, funds are not transferred between venues, and a run may require review. Profits are never guaranteed."],
  ["How often are bots and exits checked?", "The server engine checks approximately once per minute. The scalping page adds more frequent checks while open. These are not instantaneous exchange-native guarantees; fast moves, connectivity and liquidity can affect execution."],
  ["Are monthly and yearly subscriptions available?", "Pro and Elite have monthly and yearly billing options. Paid prices and checkout are not available yet. You can create a Free account now; paid purchases will open after pricing and payment setup are completed."],
];

function Signup({ label = "Create free account", className = "" }: { label?: string; className?: string }) {
  return <Button size="lg" asChild className={className}><Link to="/auth" search={{ mode: "register" }}>{label}<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>;
}
function SectionTitle({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return <div className="mb-9 max-w-2xl"><p className="mb-3 font-mono text-xs text-primary">{eyebrow}</p><h2 className="text-3xl font-semibold leading-tight sm:text-4xl">{title}</h2>{body && <p className="mt-4 text-base leading-relaxed text-muted-foreground">{body}</p>}</div>;
}
function Landing() {
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState("manual");
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const selected = MODES.find(m => m.id === mode) ?? MODES[0];
  const nav = [["Workspace", "workspace"], ["Features", "features"], ["Plans", "pricing"], ["FAQ", "faq"]];
  return <div className="landing-page min-h-screen bg-background">
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-2 px-4 md:px-7">
        <Link to="/" aria-label="AlgoVirt home"><Logo /></Link>
        <nav aria-label="Main navigation" className="hidden items-center gap-1 lg:flex">{nav.map(([label, id]) => <Button key={id} variant="ghost" asChild><a href={`#${id}`}>{label}</a></Button>)}</nav>
        <div className="flex items-center gap-1 sm:gap-2"><ThemeToggle /><Button variant="ghost" className="hidden sm:inline-flex" asChild><Link to="/auth">Sign in</Link></Button><Button asChild className="hidden sm:inline-flex"><Link to="/auth" search={{ mode: "register" }}>Start free<ArrowUpRight className="ml-1 h-4 w-4" /></Link></Button><Button variant="ghost" size="icon" aria-label={menu ? "Close navigation" : "Open navigation"} aria-expanded={menu} className="lg:hidden" onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</Button></div>
      </div>
      {menu && <nav aria-label="Mobile homepage navigation" className="grid gap-1 border-t px-4 py-3 lg:hidden">{nav.map(([label,id]) => <Button variant="ghost" asChild key={id} className="justify-start"><a href={`#${id}`} onClick={() => setMenu(false)}>{label}</a></Button>)}<Button asChild><Link to="/auth" search={{ mode: "register" }}>Create free account</Link></Button></nav>}
    </header>

    <section className="landing-hero relative flex items-center overflow-hidden">
      <img src={heroImage} alt="Sculptural mint and coral market candles connected across a metallic world map" width={1920} height={1024} fetchPriority="high" className="absolute inset-0 h-full w-full object-cover" />
      <div className="landing-reveal relative z-10 mx-auto w-full max-w-7xl px-5 py-12 md:px-7 md:py-20">
        <p className="mb-5 flex items-center gap-2 font-mono text-xs text-hero-muted"><span className="h-1.5 w-1.5 rounded-full bg-gain" />MANUAL · AI · ALGORITHMIC</p>
        <h1 className="max-w-2xl text-5xl font-semibold leading-none text-hero-foreground sm:text-7xl">AlgoVirt</h1>
        <p className="mt-5 max-w-xl text-3xl font-medium leading-tight text-hero-foreground sm:text-4xl">One workspace.<br />Every trading ambition.</p>
        <p className="mt-5 max-w-lg text-base leading-relaxed text-hero-muted sm:text-lg">Trade crypto, forex and commodities. Build with AI. Test your strategy. Automate with intention.</p>
        <div className="mt-7 flex flex-wrap gap-3"><Signup /><Button variant="secondary" size="lg" asChild><a href="#workspace">Explore the workspace<ArrowUpRight className="ml-2 h-4 w-4" /></a></Button></div>
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-hero-muted"><span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5" />Free manual trading</span><span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5" />Virtual USD wallet</span></p>
      </div>
    </section>
    <div className="border-y bg-card"><div className="mx-auto grid max-w-7xl grid-cols-2 gap-5 px-5 py-6 md:grid-cols-4 md:px-7">{[["03", "Market categories"], ["AI", "Ideas to strategies"], ["Paper → Live", "Your choice of execution"], ["Free / Pro / Elite", "A plan for your workflow"]].map(([value,label]) => <div key={label}><p className="font-mono text-sm font-medium">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div>)}</div></div>

    <section id="workspace" className="mx-auto max-w-7xl px-5 py-16 md:px-7 md:py-24">
      <SectionTitle eyebrow="THE WORKSPACE" title="From your first order to your next strategy." body="Less switching between tools. More clarity at every step of your trading process." />
      <Tabs value={mode} onValueChange={setMode}><TabsList aria-label="Trading workflows" className="mb-7 flex h-auto w-fit max-w-full flex-wrap justify-start gap-1">{MODES.map(m => <TabsTrigger value={m.id} key={m.id} className="min-h-11 gap-2"><m.icon className="h-4 w-4" />{m.label}</TabsTrigger>)}</TabsList></Tabs>
      <div className="grid items-center gap-9 lg:grid-cols-2">
        <div key={mode} className="landing-reveal"><Badge variant="outline">{selected.tier}</Badge><h3 className="mt-4 text-2xl font-semibold">{selected.title}</h3><p className="mt-4 max-w-lg leading-relaxed text-muted-foreground">{selected.body}</p><div className="mt-6 space-y-4">{selected.steps.map((step,i) => <div key={step} className="flex items-center gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border font-mono text-xs text-primary">0{i+1}</span><span className="text-sm">{step}</span></div>)}</div><Signup className="mt-7" label="Start with Free" /></div>
        <div className="landing-terminal overflow-hidden rounded-lg border bg-card" aria-label={`${selected.label} workflow preview`}>
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4"><span className="flex items-center gap-2 text-sm font-medium"><selected.icon className="h-4 w-4 text-primary" />{selected.label} workspace</span><Badge variant="outline">Preview</Badge></div>
          <div className="border-b bg-muted/30 px-5 py-5"><p className="font-mono text-xs text-muted-foreground">MARKET / WORKFLOW</p><p className="mt-2 text-lg font-medium">{selected.market}</p></div>
          <div className="space-y-0 px-5">{selected.steps.map((step,i) => <div key={step} className="flex items-center justify-between gap-4 border-b py-5 last:border-0"><selected.icon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="flex-1 text-sm">{step}</span>{i===2 ? <ArrowUpRight className="h-4 w-4 shrink-0 text-primary" /> : <CircleCheck className="h-4 w-4 shrink-0 text-gain" />}</div>)}</div>
          <div className="flex items-center gap-2 border-t px-5 py-4 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0" />{mode === "manual" ? "Virtual wallet for practice. Your broker for live trades." : mode === "ai" ? "Validate first. Simulate next. Enable live deliberately." : "Risk controls and explicit live confirmation."}</div>
        </div>
      </div>
    </section>

    <section className="border-y bg-muted/25"><div className="mx-auto max-w-7xl px-5 py-14 md:px-7"><div className="grid gap-8 lg:grid-cols-[1fr_2fr]"><div><p className="font-mono text-xs text-primary">MARKET COVERAGE</p><h2 className="mt-3 text-2xl font-semibold">Think beyond<br />a single market.</h2></div><div className="grid gap-6 sm:grid-cols-3">{[{name:"Crypto",markets:"BTC · ETH · SOL",body:"Spot markets and supported exchange accounts.",icon:CandlestickChart},{name:"Forex",markets:"EUR/USD · GBP/USD · USD/JPY",body:"Major, cross and exotic pairs with Yahoo Finance demo pricing.",icon:ArrowLeftRight},{name:"Commodities",markets:"Gold · Oil · Agriculture",body:"Metals, energy, grains and more. OANDA for supported live instruments.",icon:LineChart}].map(m => <div key={m.name}><m.icon className="h-5 w-5 text-primary" /><h3 className="mt-3 font-semibold">{m.name}</h3><p className="mt-2 font-mono text-xs text-foreground">{m.markets}</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.body}</p></div>)}</div></div><p className="mt-7 text-xs text-muted-foreground">Market data and live execution availability vary by instrument and connected account.</p></div></section>

    <section id="features" className="mx-auto max-w-7xl px-5 py-16 md:px-7 md:py-24"><SectionTitle eyebrow="BUILT FOR YOUR TRADING PROCESS" title="The tools you need. Together." body="Start hands-on, add intelligence, then expand your execution toolkit. Each feature has its place in the workflow." /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{FEATURES.map(f => <Card key={f.title} className="landing-feature p-6"><div className="flex items-center justify-between"><f.icon className={`h-6 w-6 ${f.tier === "Elite" ? "text-warning" : "text-primary"}`} /><Badge variant="outline">{f.tier}</Badge></div><h3 className="mt-6 text-lg font-semibold">{f.title}</h3><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.body}</p></Card>)}</div></section>

    <section className="border-y bg-card"><div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 md:px-7 lg:grid-cols-2"><div><SectionTitle eyebrow="CONNECTED. NOT CUSTODIAL." title="Your accounts. Your funds. Your control." body="Connect your own venue for supported live trading. AlgoVirt’s demo wallet stays separate from your real funds." /><div className="flex flex-wrap gap-2">{["Binance","Bybit","OKX","KuCoin","OANDA"].map(e => <span className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm" key={e}><Cable className="h-4 w-4 text-muted-foreground" />{e}</span>)}</div><p className="mt-4 text-xs text-muted-foreground">Coinbase market data is also available. Live arbitrage: Binance ↔ OKX spot only.</p></div><div className="space-y-0">{[{icon:LockKeyhole,title:"Encrypted exchange credentials",body:"Exchange secrets are stored encrypted on the server, not exposed in your browser."},{icon:SlidersHorizontal,title:"Account-level risk controls",body:"Configure exposure, daily-loss and position limits, with an emergency stop for supported trading paths."},{icon:ShieldCheck,title:"Deliberate live execution",body:"Start in simulation. Confirm live mode, review your setup and retain access to position exits after a plan change."}].map(s => <div className="flex gap-4 border-b py-6 first:pt-0 last:border-0" key={s.title}><s.icon className="mt-1 h-5 w-5 shrink-0 text-primary" /><div><h3 className="font-semibold">{s.title}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p></div></div>)}</div></div></section>

    <section id="pricing" className="mx-auto max-w-7xl px-5 py-16 md:px-7 md:py-24"><div className="flex flex-wrap items-end justify-between gap-5"><SectionTitle eyebrow="FREE / PRO / ELITE" title="Grow your toolkit, not your guesswork." body="A clear path from manual trading to AI and advanced execution." /><Tabs value={interval} onValueChange={v => { if(v === "monthly" || v === "yearly") setInterval(v); }} className="mb-9"><TabsList className="h-auto" aria-label="Plan billing interval"><TabsTrigger value="monthly" className="min-h-11">Monthly</TabsTrigger><TabsTrigger value="yearly" className="min-h-11">Yearly</TabsTrigger></TabsList></Tabs></div><div className="grid gap-4 lg:grid-cols-3">{PLAN_IDS.map(id => <Card className={`flex flex-col p-6 ${id === "pro" ? "border-primary/50" : id === "elite" ? "border-warning/40" : ""}`} key={id}><div className="flex items-center justify-between"><h3 className="text-2xl font-semibold">{PLAN_FEATURES[id].name}</h3><Badge variant="outline">{id === "free" ? "Start here" : id === "pro" ? "AI & automation" : "Advanced"}</Badge></div><p className="mt-3 min-h-10 text-sm text-muted-foreground">{PLAN_FEATURES[id].summary}</p><div className="my-6 border-b pb-6">{id === "free" ? <><span className="font-mono text-4xl">$0</span><span className="ml-2 text-sm text-muted-foreground">Always free</span></> : <><p className="text-xl font-semibold">Pricing coming soon</p><p className="mt-1 text-xs text-muted-foreground">{interval === "monthly" ? "Monthly billing" : "Yearly billing · billed annually"}</p></>}</div><ul className="flex-1 space-y-3">{PLAN_FEATURES[id].features.map(f => <li className="flex gap-2 text-sm" key={f}><Check className="mt-0.5 h-4 w-4 shrink-0 text-gain" /><span>{f}</span></li>)}</ul>{id === "free" ? <Signup className="mt-7 w-full" label="Start trading free" /> : <Button variant="outline" className="mt-7 min-h-11 w-full" disabled>{PLAN_FEATURES[id].name} · Coming soon</Button>}</Card>)}</div><p className="mt-5 text-xs text-muted-foreground">Paid checkout opens after prices are confirmed. Free accounts can start with manual demo trading today.</p></section>

    <section id="faq" className="border-y bg-muted/20"><div className="mx-auto grid max-w-7xl gap-8 px-5 py-16 md:px-7 lg:grid-cols-[1fr_1.6fr]"><SectionTitle eyebrow="BEFORE YOU START" title="Good questions. Clear answers." /><div>{FAQS.map(([question,answer]) => <details key={question} className="border-b py-5 first:pt-0 last:border-0"><summary className="flex min-h-11 items-center justify-between gap-4 font-medium">{question}<Plus className="h-4 w-4 shrink-0 text-muted-foreground transition-transform" /></summary><p className="mt-3 pr-5 text-sm leading-relaxed text-muted-foreground">{answer}</p></details>)}</div></div></section>
    <section className="mx-auto max-w-7xl px-5 py-16 text-center md:px-7 md:py-24"><p className="mb-4 font-mono text-xs text-primary">YOUR NEXT MOVE</p><h2 className="text-3xl font-semibold sm:text-4xl">Build a trading process<br />you can come back to.</h2><p className="mx-auto mt-5 max-w-lg text-muted-foreground">Start with a free workspace and virtual funds. Explore the markets before taking your next step.</p><Signup className="mt-7" /><p className="mt-4 text-xs text-muted-foreground">Manual trading & demo wallet included.</p></section>
    <footer className="border-t bg-card"><div className="mx-auto max-w-7xl px-5 py-9 md:px-7"><div className="flex flex-wrap items-center justify-between gap-6"><Logo /><div className="flex flex-wrap gap-2"><Button variant="ghost" asChild><a href="#features">Features</a></Button><Button variant="ghost" asChild><a href="#pricing">Plans</a></Button><Button variant="ghost" asChild><Link to="/auth">Sign in<ArrowUpRight className="ml-1 h-4 w-4" /></Link></Button></div></div><p className="mt-7 max-w-4xl text-xs leading-relaxed text-muted-foreground">Trading crypto, forex and commodities involves substantial risk and you can lose money. AI output is not financial advice. Backtests and paper results are simulations, not predictions. Stops and automated exits are not guaranteed to execute at a specified price. AlgoVirt does not custody your funds or guarantee profits.</p><nav className="mt-5 flex flex-wrap gap-4 text-xs"><Link to="/terms" className="text-muted-foreground hover:text-foreground">Terms</Link><Link to="/privacy" className="text-muted-foreground hover:text-foreground">Privacy</Link><Link to="/risk-disclosure" className="text-muted-foreground hover:text-foreground">Risk disclosure</Link><Link to="/refunds" className="text-muted-foreground hover:text-foreground">Refunds</Link></nav><p className="mt-5 text-xs text-muted-foreground">© {new Date().getUTCFullYear()} AlgoVirt. Trade with a plan.</p></div></footer>
  </div>;
}
