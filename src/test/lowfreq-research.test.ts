// Phase 4B lower-frequency research: causal fills, stop-first, gaps, funding timing, cost identity, split gaps,
// train-only selection, leakage detection, determinism and calendar-day Sharpe. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/indicators";
import { aggregate, dailySharpe, features, H, D, leakageCheck, lowfreqGrid, maxHoldMs, neighbours, selectCandidates, signalAt, simulate, splitPeriods, stats, type Costs, type Features, type Funding, type Stats, type Variant } from "@/lib/lowfreq-research";

const T0 = Date.UTC(2025, 0, 1);
const COSTS: Costs = { takerFeePct: 0.05, makerFeePct: 0.02, spreadPct: 0.01, slippagePct: 0.01 };
const flat = (n: number, p = 100): Candle[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, o: p, h: p, l: p, c: p, v: 1 }));
const V = (x: Partial<Variant> = {}): Variant => ({ id: "t", tfH: 1, family: "donchian", p1: 20, p2: 0, atrStop: 2, rr: 2, maxHoldBars: 10, vol: "any", funding: "off", mode: "taker", ...x });
const F = (n: number, atr = 1): Features => ({ atr: Array(n).fill(atr), atrPctile: Array(n).fill(0.5), emaA: Array(n).fill(null), emaB: Array(n).fill(null), hi: Array(n).fill(null), lo: Array(n).fill(null), fundingAtClose: Array(n).fill(0) });
const once = (k: number, d: -1 | 1) => (i: number) => (i === k ? d : 0) as -1 | 0 | 1;

describe("lower-frequency simulator", () => {
  it("fills at the NEXT open, never on the signal bar", () => {
    const cs = flat(30); cs[6] = { ...cs[6]!, o: 101, h: 101, l: 101, c: 101 };
    const r = simulate(cs, F(30), V(), [], COSTS, 1000, H, once(5, 1));
    expect(r.trades[0]!.entryT).toBe(cs[6]!.t); expect(r.trades[0]!.entryRef).toBe(101);
  });
  it("stop first when stop and target are both inside one bar; gap through the stop fills at the open", () => {
    const cs = flat(30); cs[8] = { ...cs[8]!, h: 105, l: 97 };
    const a = simulate(cs, F(30), V(), [], COSTS, 1000, H, once(5, 1));
    expect(a.trades[0]!.reason).toBe("stop"); expect(a.trades[0]!.exitRef).toBe(98);
    const g = flat(30); g[8] = { ...g[8]!, o: 95, h: 95, l: 94, c: 94 };
    const b = simulate(g, F(30), V(), [], COSTS, 1000, H, once(5, 1));
    expect(b.trades[0]!.exitRef).toBe(95); expect(b.trades[0]!.reason).toBe("stop");
  });
  it("funding: longs pay a positive rate, only for events strictly while held, at the event mark", () => {
    const cs = flat(30);
    const fund: Funding[] = [{ t: cs[6]!.t, rate: 0.001, mark: 100 }, { t: cs[8]!.t, rate: 0.001, mark: 100 }, { t: cs[25]!.t, rate: 0.001, mark: 100 }];
    const long = simulate(cs, F(30), V(), fund, COSTS, 1000, H, once(5, 1)).trades[0]!;
    const short = simulate(cs, F(30), V(), fund, COSTS, 1000, H, once(5, -1)).trades[0]!;
    expect(long.funding).toBeCloseTo(-1, 9); expect(short.funding).toBeCloseTo(1, 9); // only the event at bar 8
  });
  it("net = gross − fees − spread − slippage + funding, and equals the fill-price P&L", () => {
    const cs = flat(30); cs[9] = { ...cs[9]!, h: 104.5, c: 104 };
    const t = simulate(cs, F(30), V(), [{ t: cs[8]!.t, rate: 0.0005, mark: 100 }], COSTS, 1000, H, once(5, 1)).trades[0]!;
    expect(t.reason).toBe("target");
    expect(t.net).toBeCloseTo(t.gross - t.fees - t.spread - t.slippage + t.funding, 9);
    const entryFill = t.entryRef * (1 + 0.00015), exitFill = t.exitRef * (1 - 0.00015);
    expect(t.net).toBeCloseTo((exitFill - entryFill) * t.qty - t.fees + t.funding, 9);
  });
  it("maker: no fill without trade-through; the fill bar's stop is assumed hit before its target", () => {
    const cs = flat(30);
    expect(simulate(cs, F(30), V({ mode: "maker" }), [], COSTS, 1000, H, once(5, 1)).makerMissed).toBe(1);
    const d = flat(30); d[6] = { ...d[6]!, h: 105, l: 97 };
    const t = simulate(d, F(30), V({ mode: "maker" }), [], COSTS, 1000, H, once(5, 1)).trades[0]!;
    expect(t.reason).toBe("stop"); expect(t.fees).toBeCloseTo(1000 * 0.0002 + 98 * t.qty * 0.0005 * (1 - 0.00015), 6);
  });
  it("never fills across a data gap", () => {
    const cs = flat(30).filter((_, i) => i !== 6);
    expect(simulate(cs, F(29), V(), [], COSTS, 1000, H, once(5, 1)).trades).toEqual([]);
  });
  it("aggregates only complete UTC-aligned buckets", () => {
    const cs = flat(10); expect(aggregate(cs, 4).map((c) => c.t)).toEqual([T0, T0 + 4 * H]);
    expect(aggregate(cs.filter((_, i) => i !== 1), 4).map((c) => c.t)).toEqual([T0 + 4 * H]);
  });
});

describe("research discipline", () => {
  it("the grid is pre-declared, unique and its gap exceeds the longest hold", () => {
    const g = lowfreqGrid(); expect(g.length).toBe(384); expect(new Set(g.map((v) => v.id)).size).toBe(384);
    const p = splitPeriods(T0, T0 + 1000 * D, 14 * D);
    expect(14 * D).toBeGreaterThan(maxHoldMs(g));
    expect(p[1]!.from - p[0]!.to).toBe(14 * D); expect(p[2]!.from - p[1]!.to).toBe(14 * D);
    expect(p[0]!.to).toBeLessThan(p[1]!.from); expect(p[1]!.to).toBeLessThan(p[2]!.from);
    expect(neighbours(g[0]!, g).length).toBe(6 + 5);
  });
  it("selection uses train only: changing test-period data cannot change the selected set", () => {
    const mk = (n: number, t: number, net: number): Stats => ({ trades: n, grossExp: 0, netExp: net, netExpPct: 0, net: net * n, fees: 0, spread: 0, slippage: 0, funding: 0, winRate: 0.5, profitFactor: 1, maxDrawdown: 0, dailySharpe: 0, tStat: t });
    const train = new Map([["a", mk(40, 2.5, 1)], ["b", mk(40, 1.5, 1)], ["c", mk(10, 3, 1)], ["d", mk(50, 2.1, 0.5)]]);
    const val = new Map([["a", mk(20, 1, 0.2)], ["d", mk(20, -1, -0.1)]]);
    const s = selectCandidates(train, val);
    expect(s.trainPass).toEqual(["a", "d"]); expect(s.validationPass).toEqual(["a"]);
    expect(selectCandidates.length).toBe(2); // no test argument exists
    // A simulated series: perturbing candles after the train period leaves train-period trades unchanged.
    const px = (i: number) => 100 + 0.08 * i + Math.sin(i / 7) * 3;
    const cs = flat(400).map((c, i) => ({ ...c, o: px(i - 1), c: px(i), h: Math.max(px(i - 1), px(i)) + 0.3, l: Math.min(px(i - 1), px(i)) - 0.3 }));
    const cut = cs[250]!.t, v = V({ p1: 20 });
    const before = stats(simulate(cs, features(cs, H, v, []), v, [], COSTS).trades, T0, cut - 20 * H);
    const cs2 = cs.map((c, i) => (i >= 250 ? { ...c, o: c.o * 1.2, h: c.h * 1.2, l: c.l * 1.2, c: c.c * 1.2 } : c));
    const after = stats(simulate(cs2, features(cs2, H, v, []), v, [], COSTS).trades, T0, cut - 20 * H);
    expect(after).toEqual(before); expect(before.trades).toBeGreaterThan(0);
  });
  it("leakage guard passes the real signals and catches a look-ahead signal", () => {
    const cs = flat(300).map((c, i) => ({ ...c, c: 100 + ((i * 37) % 11) - 5, h: 107, l: 93 }));
    for (const v of [V(), V({ family: "ema_cross", p1: 5, p2: 12 }), V({ family: "reversion", p1: 10, p2: 10 })]) expect(leakageCheck(cs, H, v, [], [50, 120, 299]).ok).toBe(true);
    const leaky = (s: Candle[], _f: Features, _v: Variant, i: number) => (s[i + 1] && s[i + 1]!.c > s[i]!.c ? 1 : 0) as -1 | 0 | 1;
    expect(leakageCheck(cs, H, V(), [], [50, 120, 299], leaky).ok).toBe(false);
  });
  it("funding becomes visible to signals only after its timestamp", () => {
    const cs = flat(5), f = features(cs, H, V(), [{ t: cs[3]!.t + H, rate: 0.01, mark: null }]);
    expect(f.fundingAtClose.slice(0, 5)).toEqual([null, null, null, 0.01, 0.01]);
  });
  it("is deterministic and returns NO trades when nothing signals", () => {
    const cs = flat(200); const v = V(); const f = features(cs, H, v, []);
    expect(simulate(cs, f, v, [], COSTS)).toEqual(simulate(cs, f, v, [], COSTS));
    expect(simulate(cs, f, v, [], COSTS).trades).toEqual([]); expect(signalAt(cs, f, v, 100)).toBe(0);
    expect(selectCandidates(new Map(), new Map())).toEqual({ trainPass: [], checked: [], validationPass: [] });
  });
  it("daily Sharpe counts every calendar day, including days without trades", () => {
    const t = [{ exitT: T0 + 0.5 * D, net: 10 }, { exitT: T0 + 1.5 * D, net: -5 }];
    const two = dailySharpe(t, T0, T0 + 2 * D)!, ten = dailySharpe(t, T0, T0 + 10 * D)!;
    expect(two).not.toBeCloseTo(ten, 3); expect(dailySharpe(t, T0, T0 + D)).toBeNull();
  });
});
