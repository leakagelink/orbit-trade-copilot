// Phase 4C change control: no protected trading, order, exchange, credential, wallet, Autopilot, route, migration or
// prior-research file changed since the SHA-256 manifest taken before any Phase 4C edit; no new route (endpoint) file;
// and the new Phase 4C modules reach no order-capable, exchange, credential, database or AI module and are imported
// by nothing in the app.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MANIFEST = readFileSync("docs/phase-4c/protected-files.sha256", "utf8").trim().split("\n").map((l) => { const [h, ...p] = l.split(/\s+/); return { hash: h!, path: p.join(" ") }; });
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : []; }); }
function graph(entries: string[]) {
  const seen = new Set<string>(entries.map((e) => resolve(ROOT, e))), queue = [...seen];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}
const NEW = ["src/lib/ema-forward-research.ts", "src/lib/risk-data-contracts.ts", "src/lib/futures-paper-ledger-v2.ts"];
const FORBIDDEN = /futures\.server|futures-execution|futures-authorization|futures-lease|binance-futures|exchange-adapters|credential|crypto\.server|engine\.server|autopilot|wallet|ai-|integrations\/|manual\.server|arbitrage|deriv|paper\.server|\.functions|routes\/|central-risk-shadow|risk-limits/;

describe("Phase 4C change control", () => {
  it("the manifest covers the order, exchange, credential, Futures, Autopilot, route and migration files", () => {
    const paths = MANIFEST.map((m) => m.path);
    for (const p of ["src/lib/binance-futures-core.server.ts", "src/lib/futures.server.ts", "src/lib/credential-environment.server.ts", "src/lib/engine.server.ts", "src/lib/autopilot-runner.server.ts", "src/lib/central-risk-shadow.server.ts", "src/lib/futures-paper-engine.ts", "src/lib/lowfreq-research.ts", "docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql", "drizzle/migrations/0039_futures_pass_certification_and_autopilot_fencing.sql"]) expect(paths, p).toContain(p);
    expect(MANIFEST.length).toBeGreaterThan(150);
  });
  it("no protected file changed during Phase 4C (later changes only where a later phase explicitly authorized them)", () => {
    // Phase 4D's brief authorized exactly these three edits (fill-time re-validation, shadow remediation); every other
    // Phase 4C-protected file must still match. src/test/phase4d-isolation.test.ts pins the Phase 4D list.
    const LATER_AUTHORIZED = new Set(["src/lib/futures-paper-engine.ts", "src/lib/central-risk-shadow.ts", "src/lib/central-risk-shadow.server.ts"]);
    const changed = MANIFEST.filter((m) => !LATER_AUTHORIZED.has(m.path) && (!existsSync(m.path) || sha(m.path) !== m.hash)).map((m) => m.path);
    expect(changed).toEqual([]);
  });
  it("no new route (endpoint) file and no new applied migration exists", () => {
    const listed = new Set(MANIFEST.map((m) => m.path));
    // Phase 4H.8 brief §6 authorized exactly one new page (Live Scalping Command Center: UI only, no endpoint);
    // src/test/phase4h8-gate.test.ts pins that it never calls the order request and only reads the gate status.
    const LATER_AUTHORIZED_ROUTES = new Set(["src/routes/_authenticated/scalp-center.tsx"]);
    expect(walk("src/routes", /./).map((f) => relative(ROOT, f)).filter((f) => !listed.has(f) && !LATER_AUTHORIZED_ROUTES.has(f))).toEqual([]);
    expect(walk("drizzle/migrations", /\.sql$/).map((f) => relative(ROOT, f)).filter((f) => !listed.has(f))).toEqual([]);
  });
  it("the 0045 draft is byte-for-byte unchanged (hashes given in the Phase 4C brief)", () => {
    expect(sha("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql")).toBe("fa907f33269f0b2ef583e161b37b7a79b1f3db084bcb6813a7b25dfbb021cf1b");
    expect(sha("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.rollback.sql")).toBe("e80f65593d19ecb35d9d22aceae6f2dac9be75853769975fe464b0c3ea7d3892");
  });
});

describe("Phase 4C module isolation", () => {
  it("new modules reach no order, exchange, credential, wallet, Autopilot, AI, database or shadow module", () => {
    for (const f of NEW) expect(graph([f]).filter((x) => x !== f && FORBIDDEN.test(x)), f).toEqual([]);
    for (const f of NEW) expect(readFileSync(f, "utf8"), f).not.toMatch(/fetch\(|supabase|process\.env|createServerFn/);
  });
  it("nothing in the app imports the new modules (they are offline research / drafts only)", () => {
    const importers = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && !NEW.some((n) => f.endsWith(n)))
      .filter((f) => /ema-forward-research|risk-data-contracts|futures-paper-ledger-v2/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => relative(ROOT, f))).toEqual([]);
  });
  it("the draft 0046 commit function is referenced only by tests, scripts and docs — no worker or schedule calls it", () => {
    const hits = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && /futures_paper_commit_bar_v2/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(ROOT, f))).toEqual(["src/lib/futures-paper-ledger-v2.ts"].filter((f) => /futures_paper_commit_bar_v2/.test(readFileSync(f, "utf8"))));
  });
});
