import { createFileRoute } from "@tanstack/react-router";
import { GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { toolkitHead } from "@/components/toolkit-shared";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/learn")({
  head: () => toolkitHead("Learn trading", "Beginner lessons on trading basics, risk management and using Quantra's tools."),
  component: Learn,
});

const LESSONS: { level: string; title: string; body: string[] }[] = [
  { level: "Basics", title: "Buy, sell, long and short", body: ["Buying (long) profits when price rises; selling short profits when price falls.", "Every market has a bid (sell price) and ask (buy price). The gap is the spread — a cost on every trade.", "Practice with the demo wallet first: Wallet → Deposit, then Trade."] },
  { level: "Basics", title: "Reading a candlestick chart", body: ["Each candle shows open, high, low and close for one time period.", "Green candles closed higher than they opened; red closed lower.", "Use bigger timeframes (1h, 4h) to see the trend and smaller ones (1m, 5m) to time entries."] },
  { level: "Risk", title: "Stop loss and take profit", body: ["A stop loss closes a losing trade at a level you choose; take profit locks in gains.", "Set both before entering. Stops can fill worse than your price in fast markets.", "A common rule: risk no more than 1–2% of your account on one trade."] },
  { level: "Risk", title: "Position sizing", body: ["Size = (account × risk %) ÷ distance to stop.", "Example: $1,000 account, 1% risk ($10), stop $2 away → buy 5 units.", "Set account-wide daily loss limits on the Risk page."] },
  { level: "Tools", title: "Indicators: EMA, RSI, MACD", body: ["EMA smooths price; a fast EMA crossing above a slow EMA can signal an uptrend.", "RSI above 70 is often called overbought, below 30 oversold — not a guarantee of reversal.", "MACD compares two EMAs to show momentum shifts."] },
  { level: "Tools", title: "Building and testing a strategy (Pro)", body: ["Combine entry and exit rules in the Strategy builder.", "Backtest on history, then run on paper before considering live mode.", "Backtests include fees, but real slippage can be worse."] },
  { level: "Advanced", title: "Bots, scalping and arbitrage", body: ["Bots trade your rules automatically — monitor them and use risk limits.", "Scalping (Elite) targets small, fast moves; fees matter a lot.", "Arbitrage (Elite) buys on one exchange and sells on another; both legs may not fill together."] },
  { level: "Mindset", title: "Trading journal and discipline", body: ["Write down why you entered, how you felt and what happened.", "Review weekly: repeat what works, cut what doesn't.", "Never chase losses by increasing size."] },
];

function Learn() {
  return (
    <div>
      <PageHeader title="Learn trading" description="Short lessons for beginners. Information only — not financial advice." />
      <div className="space-y-6 px-5 pb-8 md:px-7">
        <OnboardingChecklist force />
        <Accordion type="single" collapsible className="rounded-lg border bg-card px-4">
          {LESSONS.map(l => (
            <AccordionItem key={l.title} value={l.title}>
              <AccordionTrigger><span className="flex items-center gap-3 text-left"><GraduationCap className="h-4 w-4 shrink-0 text-primary" />{l.title}<Badge variant="outline" className="hidden sm:inline-flex">{l.level}</Badge></span></AccordionTrigger>
              <AccordionContent><ul className="space-y-2 pl-7 text-sm text-muted-foreground">{l.body.map(b => <li key={b} className="list-disc">{b}</li>)}</ul></AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}
