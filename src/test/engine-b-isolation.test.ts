// Engine B (scalping AI), its model research and the Central Risk Engine are pure: they import no server, order,
// credential, wallet, exchange-adapter or AI-provider module, so no seconds-level decision can involve an LLM and no
// signal or ACCEPT can reach an exchange. Walks the real import graph.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
function graph(entries: string[]) {
  const seen = new Set<string>(entries.map((e) => resolve(ROOT, e))), queue = [...seen];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (!hit) throw new Error(`Unresolved ${spec} in ${file}`);
      if (!seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}
const ENTRIES = ["src/lib/central-risk.ts", "src/lib/central-risk-proposals.ts", "src/lib/scalp-intraday.ts", "src/lib/scalp-microstructure.ts", "src/lib/scalp-model.ts", "src/lib/ml-logistic.ts", "src/lib/ml-gbdt.ts", "src/lib/scalp-research.ts", "src/lib/lowfreq-research.ts", "src/lib/central-risk-shadow.ts"];
const FORBIDDEN = /\.server\.ts$|\.functions\.ts$|src\/routes\/|src\/integrations\/|ai-provider|ai-prime|exchange-adapters|futures|binance|deriv|wallet|engine|autopilot|manual|arbitrage/;

describe("Engine B and the Central Risk Engine are pure", () => {
  const files = graph(ENTRIES);
  it("walks the graph (sanity)", () => { expect(files).toContain("src/lib/backtest-costs.ts"); expect(files).toContain("src/lib/indicators.ts"); });
  it("reach no server, order, exchange, wallet or AI module", () => { expect(files.filter((f) => FORBIDDEN.test(f))).toEqual([]); });
  it("contain no network or timer call", () => {
    for (const f of ENTRIES) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bfetch\(|new WebSocket|setTimeout|setInterval|process\.env/);
  });
});

// Futures PAPER engine: pure, depends only on the Central Risk Engine; separate from the Spot paper ledger and from every
// live/Testnet Futures, credential, wallet, bot, Autopilot and AI module. Nothing in the app imports it yet.
describe("Futures paper engine is isolated", () => {
  const files = graph(["src/lib/futures-paper-engine.ts"]);
  it("imports only the Central Risk Engine", () => { expect(files.sort()).toEqual(["src/lib/central-risk.ts", "src/lib/futures-paper-engine.ts"]); });
  it("has no network, timer, environment or exchange order code", () => {
    expect(readFileSync("src/lib/futures-paper-engine.ts", "utf8")).not.toMatch(/\bfetch\(|new WebSocket|setTimeout|setInterval|process\.env|\/fapi\/|supabase/);
  });
  it("is not imported by the Spot paper engine, the live Futures path or any route", () => {
    const users = ["src/lib/paper-engine.ts", "src/lib/paper.server.ts", "src/lib/futures.server.ts", "src/lib/futures-execution.ts", "src/lib/engine.server.ts", "src/lib/autopilot-tools.server.ts"];
    for (const f of users) expect(graph([f]), f).not.toContain("src/lib/futures-paper-engine.ts");
  });
  it("the Central Risk context builder is not called from any order path or route yet", () => {
    for (const f of ["src/lib/futures.server.ts", "src/lib/engine.server.ts", "src/lib/autopilot-tools.server.ts", "src/lib/futures.functions.ts", "src/lib/manual.server.ts"]) expect(graph([f]), f).not.toContain("src/lib/central-risk-context.server.ts");
  });
});
