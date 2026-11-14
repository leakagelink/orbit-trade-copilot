// Phase 4D change control: only the three files the Phase 4D brief authorized changed among the 174 protected files
// fingerprinted at the start of the sprint; draft migrations 0045/0046 are byte-identical; draft 0047 exists only as a
// proposal (not in the applied Drizzle journal); no new route; the changed engine and shadow modules stay out of every
// order, exchange, credential, wallet, Autopilot and AI path, and the new engine entry points are used only by tests.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const START = readFileSync("docs/phase-4d/protected-files-at-start.sha256", "utf8").trim().split("\n").map((l) => { const [h, ...p] = l.split(/\s+/); return { hash: h!, path: p.join(" ") }; });
const AUTHORIZED = ["src/lib/central-risk-shadow.server.ts", "src/lib/central-risk-shadow.ts", "src/lib/futures-paper-engine.ts"];
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
const FORBIDDEN = /futures\.server|futures-execution|futures-authorization|futures-lease|binance-futures|exchange-adapters|credential|crypto\.server|engine\.server|autopilot|wallet|ai-|integrations\/|manual\.server|arbitrage|deriv|paper\.server|\.functions|routes\//;

describe("Phase 4D change control", () => {
  it("the start-of-sprint fingerprint equals the Phase 4C manifest (no drift before Phase 4D edits)", () => {
    const c = readFileSync("docs/phase-4c/protected-files.sha256", "utf8").trim().split("\n").map((l) => l.split(/\s+/).join(" "));
    expect(START.map((m) => `${m.hash} ${m.path}`)).toEqual(c);
  });
  it("only the three authorized files changed among the protected files", () => {
    const changed = START.filter((m) => !existsSync(m.path) || sha(m.path) !== m.hash).map((m) => m.path).sort();
    expect(changed.filter((p) => !AUTHORIZED.includes(p))).toEqual([]);
    for (const p of AUTHORIZED) expect(START.map((m) => m.path), p).toContain(p);
  });
  it("drafts 0045 and 0046 are byte-identical; 0047 is a draft only and nothing was added to the applied journal", () => {
    expect(sha("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql")).toBe("fa907f33269f0b2ef583e161b37b7a79b1f3db084bcb6813a7b25dfbb021cf1b");
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql")).toBe("eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e");
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql")).toBe("dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453");
    const journal = readFileSync("drizzle/migrations/meta/_journal.json", "utf8");
    expect(journal).not.toMatch(/0040|0041|0042|0043|0044|0045|0046|0047/);
    const listed = new Set(START.map((m) => m.path));
    expect(walk("drizzle/migrations", /\.sql$/).map((f) => relative(ROOT, f)).filter((f) => !listed.has(f))).toEqual([]);
    // Phase 4H.8 brief §6 authorized exactly one new page (Live Scalping Command Center: UI only, no endpoint);
    // src/test/phase4h8-gate.test.ts pins that it never calls the order request and only reads the gate status.
    const LATER_AUTHORIZED_ROUTES = new Set(["src/routes/_authenticated/scalp-center.tsx"]);
    expect(walk("src/routes", /./).map((f) => relative(ROOT, f)).filter((f) => !listed.has(f) && !LATER_AUTHORIZED_ROUTES.has(f))).toEqual([]);
  });
});

describe("Phase 4D module isolation", () => {
  it("the changed engine and shadow modules reach no order, exchange, credential, wallet, Autopilot or AI module", () => {
    for (const f of AUTHORIZED) expect(graph([f]).filter((x) => x !== f && FORBIDDEN.test(x)), f).toEqual([]);
    expect(readFileSync("src/lib/futures-paper-engine.ts", "utf8")).not.toMatch(/fetch\(|supabase|process\.env|createServerFn|\.rpc\(/);
  });
  it("the new engine entry points (account candle, commit-refusal planner) are used only by tests — no worker exists", () => {
    const hits = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && !f.endsWith("futures-paper-engine.ts"))
      .filter((f) => /stepFuturesPaperCandle|planCommitRefusal|classifyOrderSnapshot|claim_futures_order_strategy_identity/.test(readFileSync(f, "utf8")));
    // Phase 4F (owner-approved engine alignment + disabled worker): exactly these modules may name the entry points; the
    // Phase 4F alignment test proves nothing in the app imports them and no route, cron or schedule exists.
    const PHASE_4F = ["src/lib/futures-paper-engine-v3.ts", "src/lib/futures-paper-worker.ts"];
    expect(hits.map((f) => relative(ROOT, f)).filter((f) => f !== "src/lib/central-risk-shadow.ts" && !PHASE_4F.includes(f))).toEqual([]);
  });
});
