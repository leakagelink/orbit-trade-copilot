// Phase 3 isolation: forward paper trading may read public candles and its own ledger, but no module that can place an
// exchange order, change real positions/bots/wallet/settings, read exchange credentials, run Autopilot/Futures or call
// AI. Walks the real import graph (static and dynamic imports) from every paper entry point.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchPaperCandles, PAPER_KLINE_HOSTS } from "@/lib/paper-market-data.server";

const ROOT = process.cwd();
function resolveImport(from: string, spec: string) {
  const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && statSync(c).isFile()) return c;
  throw new Error(`Unresolved import ${spec} in ${from}`);
}
function reachable(entries: string[]) {
  const seen = new Map<string, string>();
  const queue = entries.map((e) => resolve(ROOT, e));
  for (const e of queue) seen.set(e, "(entry)");
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g)) {
      const next = resolveImport(file, (m[1] ?? m[2] ?? m[3])!);
      if (next && !seen.has(next)) { seen.set(next, file); queue.push(next); }
    }
  }
  return new Map([...seen].map(([k, v]) => [relative(ROOT, k), v === "(entry)" ? v : relative(ROOT, v)]));
}
const PAPER_ENTRIES = ["src/lib/paper.server.ts", "src/lib/paper.functions.ts", "src/lib/paper-engine.ts", "src/lib/paper-risk.ts", "src/lib/paper-metrics.ts", "src/lib/paper-market-data.server.ts", "src/routes/api/public/paper/tick.ts", "src/routes/_authenticated/paper.tsx", "src/components/paper/paper-report.tsx", "src/components/paper/paper-start-dialog.tsx"];
const FORBIDDEN = /src\/lib\/(engine|exchange-adapters|manual|futures[\w-]*|binance-futures[\w-]*|deriv-trade|deriv|arbitrage[\w-]*|autopilot[\w-]*|credential-environment|crypto|scalp[\w-]*|ai-prime|chat|research[\w-]*|wallet[\w-]*|risk-limits|bots)\.server\.ts$|src\/lib\/(emergency-recovery|futures-execution|arbitrage-recovery|wallet-math|research[\w-]*|ai-provider)\.ts$|src\/lib\/(?!paper|security)[\w-]+\.functions\.ts$|src\/routes\/api\/(?!public\/paper\/)/;

describe("paper trading cannot reach execution, wallet or AI code", () => {
  const graph = reachable(PAPER_ENTRIES);
  it("walks a non-trivial graph (sanity)", () => {
    expect(graph.size).toBeGreaterThan(15);
    expect(graph.has("src/lib/paper-engine.ts")).toBe(true);
    expect(graph.has("src/lib/backtest-costs.ts")).toBe(true);
  });
  it("no paper entry point imports an order, credential, wallet, bot, Autopilot, Futures or AI module", () => {
    expect([...graph].filter(([f]) => FORBIDDEN.test(f)).map(([f, by]) => `${f} <- ${by}`)).toEqual([]);
  });
  it("the detector would catch a regression (control)", () => {
    expect([...reachable(["src/lib/engine.server.ts"]).keys()].some((f) => FORBIDDEN.test(f))).toBe(true);
  });
  it("the paper modules never write real trading, wallet or exchange tables", () => {
    for (const f of PAPER_ENTRIES.filter((f) => f.startsWith("src/lib/"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\("(orders|positions|trades|trading_bots|exchange_connections|connection_credentials|wallets?|wallet_\w+|risk_settings|portfolio_snapshots)"\)/);
      expect(src, f).not.toMatch(/placeMarketOrder|wallet_apply|signRequest|hmac/i);
    }
  });
});

describe("paper market data is public and read-only", () => {
  it("only sends credential-free GET requests to the public kline endpoints", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify([[0, "1", "1", "1", "1", "1"]])); });
    await fetchPaperCandles("BTC/USDT", "1h", 10, fake as unknown as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(new RegExp(`^${PAPER_KLINE_HOSTS[0].replace(/\./g, "\\.")}/api/v3/klines\\?symbol=BTCUSDT&interval=1h&limit=10$`));
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.credentials).toBe("omit");
    expect(new Headers(calls[0]!.init?.headers).get("X-MBX-APIKEY")).toBeNull();
  });
  it("falls back to the second public host, then reports an outage instead of inventing candles", async () => {
    const urls: string[] = [];
    const down = vi.fn(async (url: string | URL | Request) => { urls.push(String(url)); return new Response("unavailable", { status: 503 }); });
    await expect(fetchPaperCandles("BTC/USDT", "1h", 10, down as unknown as typeof fetch)).rejects.toThrow(/503/);
    expect(urls.map((u) => new URL(u).origin)).toEqual([...PAPER_KLINE_HOSTS]);
  });
});
