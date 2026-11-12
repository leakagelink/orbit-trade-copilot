// Phase 1 isolation: AI research may reach the read-only Risk Engine check, but no module that can place orders,
// change positions, bots, Autopilot, Futures, credentials or the emergency stop. Walks the real import graph
// (static and dynamic imports) from every research entry point.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as engine from "@/lib/engine.server";
import * as riskLimits from "@/lib/risk-limits.server";

const ROOT = process.cwd();
function resolveImport(from: string, spec: string) {
  const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null; // package import
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && statSync(c).isFile()) return c;
  throw new Error(`Unresolved import ${spec} in ${from}`);
}
/** Every local module reachable from the entry points, with the module that first imported it. */
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

const RESEARCH_ENTRIES = [
  "src/routes/_authenticated/research.tsx", "src/lib/research.functions.ts", "src/lib/research-insights.functions.ts",
  "src/lib/research-paper.functions.ts", "src/lib/research-run.server.ts", "src/lib/research.server.ts", "src/lib/research-risk.server.ts",
];
// Modules that can submit orders, change positions/bots/settings, read exchange credentials or run trading flows.
const EXECUTION = /src\/lib\/(engine|exchange-adapters|manual|futures[\w-]*|binance-futures[\w-]*|deriv-trade|deriv|arbitrage[\w-]*|autopilot[\w-]*|credential-environment|crypto|scalp[\w-]*)\.server\.ts$|src\/lib\/(emergency-recovery|futures-execution|arbitrage-recovery)\.ts$|src\/lib\/(?!research)[\w-]+\.functions\.ts$|src\/routes\/api\//;

describe("research cannot reach execution code", () => {
  const graph = reachable(RESEARCH_ENTRIES);
  it("walks a non-trivial graph (sanity)", () => {
    expect(graph.size).toBeGreaterThan(30);
    expect(graph.has("src/lib/risk-limits.server.ts")).toBe(true); // the read-only Risk Engine check IS reachable
    expect(graph.has("src/lib/research-risk.server.ts")).toBe(true);
  });
  it("no research entry point imports any execution module, directly or transitively", () => {
    const hits = [...graph].filter(([f]) => EXECUTION.test(f)).map(([f, by]) => `${f} <- ${by}`);
    expect(hits).toEqual([]);
  });
  it("the read-only risk modules import nothing beyond SELECT-only helpers", () => {
    const g = reachable(["src/lib/risk-limits.server.ts", "src/lib/research-risk.server.ts"]);
    // client.server/types appear only through the `typeof import(...)` type of the database handle.
    expect([...g.keys()].sort()).toEqual(["src/integrations/supabase/client.server.ts", "src/integrations/supabase/types.ts", "src/lib/research-risk-preview.ts", "src/lib/research-risk.server.ts", "src/lib/risk-limits.server.ts", "src/lib/trade-accounting.ts"].sort());
    for (const f of ["src/lib/risk-limits.server.ts", "src/lib/research-risk.server.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(|placeMarketOrder|fetch\(/);
    }
  });
  it("the detector would catch a regression (control)", () => {
    const g = reachable(["src/lib/engine.server.ts"]);
    expect([...g.keys()].some((f) => EXECUTION.test(f))).toBe(true);
  });
});

describe("trading keeps the authoritative Risk Engine", () => {
  it("engine.server exports the very same accountRiskBlock function research uses", () => {
    expect(engine.accountRiskBlock).toBe(riskLimits.accountRiskBlock);
  });
  it("trading entry paths still call accountRiskBlock before entries", () => {
    for (const f of ["src/lib/engine.server.ts", "src/lib/manual.server.ts", "src/lib/futures.server.ts", "src/lib/arbitrage.server.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/accountRiskBlock\(/);
    }
  });
  it("research sizing never comes from AI text, and research evaluations never authorize execution", () => {
    const src = readFileSync("src/lib/research-risk-evaluation.ts", "utf8");
    expect(src).toMatch(/executionAuthorized: false/);
    expect(src).not.toMatch(/executionAuthorized: true/);
  });
});
