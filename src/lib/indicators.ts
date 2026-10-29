// Pure indicator math + rule evaluation. Shared by the engine (server) and tests.
import type { Condition, Indicator, StrategyConfig } from "./strategy";

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export type Series = (number | null)[];

export function sma(xs: Series, p: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  let sum = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x == null) { sum = 0; n = 0; continue; }
    sum += x; n++;
    if (n > p) { sum -= xs[i - p] as number; n = p; }
    if (n === p) out[i] = sum / p;
  }
  return out;
}

export function ema(xs: Series, p: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  const k = 2 / (p + 1);
  let prev: number | null = null, seed: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x == null) continue;
    if (prev == null) {
      seed.push(x);
      if (seed.length === p) { prev = seed.reduce((a, b) => a + b, 0) / p; out[i] = prev; seed = []; }
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], p: number): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function atr(cs: Candle[], p: number): Series {
  const tr = cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c))));
  const out: Series = new Array(cs.length).fill(null);
  if (cs.length < p) return out;
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out[p - 1] = a;
  for (let i = p; i < cs.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
  return out;
}

/**
 * Main value per indicator:
 * MACD → histogram (MACD line − signal), BBANDS → %B (0 = lower band, 1 = upper band),
 * STOCH_RSI → %K (0–100), VOLUME → volume SMA. Others are their usual line.
 */
export function computeIndicator(ind: Indicator, cs: Candle[]): Series {
  const closes = cs.map((c) => c.c);
  const p = (k: string, d: number) => Math.round(ind.params[k] ?? d);
  switch (ind.type) {
    case "RSI": return rsi(closes, p("period", 14));
    case "EMA": return ema(closes, p("period", 20));
    case "SMA": return sma(closes, p("period", 50));
    case "ATR": return atr(cs, p("period", 14));
    case "VOLUME": return sma(cs.map((c) => c.v), p("period", 20));
    case "MACD": {
      const f = ema(closes, p("fast", 12)), s = ema(closes, p("slow", 26));
      const line = closes.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
      const sig = ema(line, p("signal", 9));
      return line.map((v, i) => (v != null && sig[i] != null ? v - (sig[i] as number) : null));
    }
    case "BBANDS": {
      const per = p("period", 20), k = ind.params["stddev"] ?? 2;
      const mid = sma(closes, per);
      return closes.map((c, i) => {
        const m = mid[i];
        if (m == null) return null;
        const win = closes.slice(i - per + 1, i + 1);
        const sd = Math.sqrt(win.reduce((a, x) => a + (x - m) ** 2, 0) / per);
        return sd === 0 ? 0.5 : (c - (m - k * sd)) / (2 * k * sd);
      });
    }
    case "STOCH_RSI": {
      const per = p("period", 14);
      const r = rsi(closes, per);
      const st: Series = r.map((v, i) => {
        if (v == null || i < per - 1) return null;
        const win = r.slice(i - per + 1, i + 1);
        if (win.some((x) => x == null)) return null;
        const lo = Math.min(...(win as number[])), hi = Math.max(...(win as number[]));
        return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
      });
      return sma(st, p("k", 3));
    }
  }
}

export type SeriesMap = Record<string, Series>;

export function computeAll(cfg: StrategyConfig, cs: Candle[]): SeriesMap {
  const m: SeriesMap = { price: cs.map((c) => c.c) };
  for (const ind of cfg.indicators) m[ind.id] = computeIndicator(ind, cs);
  return m;
}

function val(op: string, m: SeriesMap, i: number): number | null {
  if (m[op]) return m[op][i] ?? null;
  const n = Number(op);
  return Number.isFinite(n) ? n : null;
}

export function evalCondition(c: Condition, m: SeriesMap, i: number): boolean {
  const a = val(c.left, m, i), b = val(c.right, m, i);
  if (a == null || b == null) return false;
  switch (c.operator) {
    case "<": return a < b;
    case ">": return a > b;
    case "<=": return a <= b;
    case ">=": return a >= b;
    case "crosses_above":
    case "crosses_below": {
      const pa = val(c.left, m, i - 1), pb = val(c.right, m, i - 1);
      if (pa == null || pb == null) return false;
      return c.operator === "crosses_above" ? pa <= pb && a > b : pa >= pb && a < b;
    }
  }
}

export function evalRules(rules: { logic: "all" | "any"; conditions: Condition[] }, m: SeriesMap, i: number): boolean {
  if (!rules.conditions.length) return false;
  const r = rules.conditions.map((c) => evalCondition(c, m, i));
  return rules.logic === "all" ? r.every(Boolean) : r.some(Boolean);
}
