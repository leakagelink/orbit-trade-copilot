// Phase 4C EMA forward research: reproducibility, equivalence with the Phase 4B benchmark, causality, frozen spec and
// the pre-declared decision rule. Pure; no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/indicators";
import { aggregate, D, emaAlwaysIn, H, type Funding } from "@/lib/lowfreq-research";
import { EMA_FORWARD_SPEC, emaAlwaysInTrades, emaMetrics, emaSpecHash, emaVerdict, rollingWindows, scaleCosts, type EmaMetrics, type SymbolEvidence } from "@/lib/ema-forward-research";

function series(n: number, seed = 7, t0 = Date.UTC(2020, 0, 1)): Candle[] {
  let x = seed, p = 100; const out: Candle[] = [];
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) { const drift = Math.sin(i / 300) * 0.004; const o = p; p = Math.max(1, p * (1 + drift + (rnd() - 0.5) * 0.02)); out.push({ t: t0 + i * H, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 1000 }); }
  return out;
}
const fund = (cs: Candle[]): Funding[] => cs.filter((c) => c.t % (8 * H) === 0).map((c, k) => ({ t: c.t, rate: ((k % 7) - 3) * 0.00005, mark: k % 3 ? c.o : null }));
const C = EMA_FORWARD_SPEC.costs;

describe("EMA forward research — equivalence with the Phase 4B benchmark", () => {
  const c1 = series(6000), c4 = aggregate(c1, 4), f = fund(c1);
  for (const [fast, slow, cs, tf] of [[50, 200, c4, 4 * H], [20, 100, c4, 4 * H], [50, 200, c1, H]] as const) {
    it(`emaAlwaysInTrades reproduces emaAlwaysIn exactly (${fast}/${slow}, ${tf / H}h)`, () => {
      const from = cs[300]!.t, to = cs.at(-50)!.t;
      const a = emaAlwaysIn(cs, f, from, to, C, fast, slow, 1000, tf);
      const b = emaMetrics(emaAlwaysInTrades(cs, f, from, to, C, fast, slow, 1000, tf), from, to, 1000);
      for (const k of Object.keys(a) as (keyof typeof a)[]) expect(b[k], k).toEqual(a[k]);
      expect(a.trades).toBeGreaterThan(3);
    });
  }
});

describe("EMA forward research — causality and determinism", () => {
  const c4 = aggregate(series(6000, 11), 4), f = fund(series(6000, 11));
  it("is deterministic", () => {
    const x = emaAlwaysInTrades(c4, f, c4[250]!.t, c4.at(-1)!.t + 4 * H, C, 50, 200, 1000, 4 * H), y = emaAlwaysInTrades(c4, f, c4[250]!.t, c4.at(-1)!.t + 4 * H, C, 50, 200, 1000, 4 * H);
    expect(y).toEqual(x);
  });
  it("trades closed before bar k do not change when later candles are removed (no look-ahead)", () => {
    const from = c4[250]!.t, full = emaAlwaysInTrades(c4, f, from, c4.at(-1)!.t + 4 * H, C, 50, 200, 1000, 4 * H).trades;
    for (const k of [600, 900, 1300]) {
      const cut = c4.slice(0, k), part = emaAlwaysInTrades(cut, f, from, cut.at(-1)!.t + 4 * H, C, 50, 200, 1000, 4 * H).trades;
      const before = (ts: typeof full) => ts.filter((t) => t.exitT < cut.at(-1)!.t);
      expect(before(part)).toEqual(before(full));
    }
  });
  it("higher costs never improve net results", () => {
    const from = c4[250]!.t, to = c4.at(-1)!.t + 4 * H;
    const base = emaMetrics(emaAlwaysInTrades(c4, f, from, to, C, 50, 200, 1000, 4 * H), from, to), stress = emaMetrics(emaAlwaysInTrades(c4, f, from, to, scaleCosts(C, 2), 50, 200, 1000, 4 * H), from, to);
    expect(stress.net).toBeLessThan(base.net);
    expect(stress.trades).toBe(base.trades);
  });
  it("marked drawdown is at least the realized drawdown", () => {
    const from = c4[250]!.t, to = c4.at(-1)!.t + 4 * H, m = emaMetrics(emaAlwaysInTrades(c4, f, from, to, C, 50, 200, 1000, 4 * H), from, to);
    expect(m.maxDrawdownMarked + 1e-9).toBeGreaterThanOrEqual(m.maxDrawdown);
    expect(m.exposurePct).toBeGreaterThan(90); // always-in
  });
});

describe("EMA forward research — frozen specification and windows", () => {
  it("matches the spec recorded before any new data was scored", async () => {
    const rec = JSON.parse(readFileSync("docs/phase-4c/ema-forward-spec.json", "utf8")) as { specSha256: string; spec: unknown };
    expect(await emaSpecHash()).toBe(rec.specSha256);
    expect(JSON.parse(JSON.stringify(EMA_FORWARD_SPEC))).toEqual(rec.spec);
  });
  it("keeps the unseen history, the contaminated Phase 4B window and the forward window apart with an embargo", () => {
    const w = EMA_FORWARD_SPEC.windows;
    expect(w.contaminatedFrom - w.historyUnseenEnd).toBe(14 * D);
    expect(w.forwardFrom).toBe(w.contaminatedTo);
    expect(new Date(w.contaminatedFrom).toISOString()).toBe("2023-11-13T00:00:00.000Z");
    expect(new Date(w.forwardFrom).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(EMA_FORWARD_SPEC.candidate.emaFast).toBe(50); expect(EMA_FORWARD_SPEC.candidate.emaSlow).toBe(200);
  });
  it("rolling walk-forward windows are non-overlapping and drop a trailing partial window", () => {
    const ws = rollingWindows(0, 200 * D, 90);
    expect(ws.map((w) => [w.from, w.to])).toEqual([[0, 90 * D], [90 * D, 180 * D]]);
  });
});

describe("EMA forward research — pre-declared decision rule", () => {
  const m = (o: Partial<EmaMetrics>): EmaMetrics => ({ trades: 40, grossExp: 10, netExp: 8, netExpPct: 0.8, net: 320, fees: 1, spread: 1, slippage: 1, funding: 0, winRate: 0.5, profitFactor: 1.5, maxDrawdown: 50, dailySharpe: 1, tStat: 2.5, totalNetReturnPct: 32, avgWin: 20, avgLoss: -10, exposurePct: 100, avgHoldHours: 100, maxDrawdownMarked: 60, ...o });
  const good: SymbolEvidence = { full: m({}), train: m({}), validation: m({ trades: 10 }), test: m({ trades: 10 }), windows: { traded: 10, positive: 7 }, stressFull: m({ netExp: 1 }), forward: null };
  it("strong history without forward trades is INSUFFICIENT EVIDENCE, never a candidate", () => {
    const v = emaVerdict(good); expect(v.verdict).toBe("INSUFFICIENT EVIDENCE"); expect(v.status).toBe("RESEARCH_ONLY"); expect(v.rules.R6.pass).toBe(false);
  });
  it("too few forward trades stays INSUFFICIENT EVIDENCE", () => { expect(emaVerdict({ ...good, forward: m({ trades: 29 }) }).verdict).toBe("INSUFFICIENT EVIDENCE"); });
  it("any failed history rule is NO TRADE even with good forward results", () => {
    for (const bad of [{ full: m({ tStat: 1.9 }) }, { full: m({ trades: 29 }) }, { test: m({ net: -1, trades: 10 }) }, { validation: m({ trades: 7 }) }, { windows: { traded: 10, positive: 5 } }, { full: m({ profitFactor: 1.19 }) }, { stressFull: m({ netExp: -0.01 }) }, { full: null }])
      expect(emaVerdict({ ...good, ...bad, forward: m({ trades: 50 }) }).verdict).toBe("NO TRADE");
  });
  it("only all six rules give a review candidate, and it is still RESEARCH_ONLY", () => {
    const v = emaVerdict({ ...good, forward: m({ trades: 30 }) }); expect(v.verdict).toBe("CANDIDATE FOR FORWARD-PAPER REVIEW"); expect(v.status).toBe("RESEARCH_ONLY");
  });
});
