// Phase 4F change control (engine alignment E1–E4 + disabled worker): the Phase 4D core engine and the Central Risk
// modules are byte-identical; every draft migration (0045–0049 and rollbacks) is byte-identical and unapplied; the new
// paper modules are pure, reach nothing order-capable and are imported by nothing in the app; the worker is OFF by
// default and has no route, cron entry or schedule; the real Futures order paths cannot reach any of it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT } from "@/lib/futures-paper-worker";

const ROOT = process.cwd();
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []; }
function graph(entry: string) {
  const seen = new Set<string>([resolve(ROOT, entry)]), queue = [...seen];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) { if (spec !== "zod") seen.add(`pkg:${spec}`); continue; }
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => (f.startsWith("pkg:") ? f : relative(ROOT, f)));
}
const NEW = ["src/lib/futures-paper-engine-v3.ts", "src/lib/futures-paper-market-data.ts", "src/lib/futures-paper-worker.ts", "src/lib/futures-paper-worker-queries.ts"];
const ALLOWED_DEPS = new Set([...NEW, "src/lib/futures-paper-engine.ts", "src/lib/central-risk.ts", "src/lib/account-risk-budget.ts", "src/lib/futures-paper-ledger-v3.ts"]);

describe("Phase 4F change control", () => {
  it("the core engine, Central Risk Engine and shadow modules are byte-identical (alignment lives in a separate layer)", () => {
    expect(sha("src/lib/futures-paper-engine.ts")).toBe("588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9");
    expect(sha("src/lib/central-risk.ts")).toBe("0d1006bb06822a6749cacfeaf84b0533214aa6be3bc7f655467ae61fd2aace8d");
    expect(sha("src/lib/central-risk-shadow.ts")).toBe("76f27f3e2e8c3eff0cb11e27297cd26f7202f07062bb1e9878d17cdf103aa4cf");
    expect(sha("src/lib/central-risk-shadow.server.ts")).toBe("dda46802ad54f209c139ed48c1bdd0acfc5acefb6a16c57e4eb69ed6ca377037");
    expect(sha("src/lib/account-risk-budget.ts")).toBe("59375a134ba71905beafd6e0c753a899baaf2461ebc88befbe2b35f85005dbac");
    expect(sha("src/lib/futures-paper-ledger-v3.ts")).toBe("65be37d3a01a4cfbac5b5a9ef69676e06a1d5aa1d8135934b9b23315c3b18dbd");
  });
  it("draft migrations are byte-identical and none is applied (journal ends at 0039; no 004x file in drizzle or supabase)", () => {
    const pins: Record<string, string> = {
      "0046_futures_paper_ledger_v2.sql": "eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e",
      "0047_futures_strategy_attribution.sql": "42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b",
      "0048_futures_strategy_attribution_v2.sql": "93305df74b2636e47f0464b9d57fd14d455ba15604d9b619c872fe61e0ba60bb",
      "0048_futures_strategy_attribution_v2.rollback.sql": "9930d14841197737a46b57ac845d08fc6ace840170693226e6586aac6fea504f",
      "0049_futures_paper_ledger_v3.sql": "fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35",
      "0049_futures_paper_ledger_v3.rollback.sql": "e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb",
    };
    for (const [f, h] of Object.entries(pins)) expect(sha(`docs/proposed-migrations/${f}`), f).toBe(h);
    const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    expect([...walk("drizzle", /\.sql$/), ...walk("supabase", /\.sql$/)].filter((f) => /004\d_|futures_paper|risk_approval/.test(f))).toEqual([]);
  });
});

describe("Phase 4F module isolation", () => {
  it("the new modules depend only on the pure paper engine, the Central Risk Engine, the budget module and the payload builder", () => {
    for (const f of NEW) expect(graph(f).filter((x) => !ALLOWED_DEPS.has(x)), f).toEqual([]);
    for (const f of NEW) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bfetch\(|supabase|process\.env|import\.meta\.env|createServerFn|new WebSocket|setTimeout|setInterval|\/fapi\//);
  });
  it("nothing in the app imports them; the real Futures order paths, Autopilot and the Spot paper path cannot reach them", () => {
    const app = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && !NEW.some((n) => f.endsWith(n)));
    expect(app.filter((f) => /futures-paper-engine-v3|futures-paper-market-data|futures-paper-worker/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
    for (const f of ["src/lib/futures.server.ts", "src/lib/futures-execution.ts", "src/lib/engine.server.ts", "src/lib/autopilot-tools.server.ts", "src/lib/paper.server.ts", "src/lib/manual.server.ts"].filter(existsSync)) {
      expect(graph(f).filter((x) => NEW.includes(x)), f).toEqual([]);
    }
  });
});

describe("the worker is disabled", () => {
  it("is off by default; no route, server function, cron entry or schedule names it", () => {
    expect(FUTURES_PAPER_WORKER_ENABLED_BY_DEFAULT).toBe(false);
    const src = readFileSync("src/lib/futures-paper-worker.ts", "utf8");
    expect(src).toMatch(/if \(opts\?\.enabled !== true\) return \{ status: "disabled"/);
    const places = [...walk("src/routes", /./), ...walk("supabase", /./), ...["wrangler.toml", "wrangler.jsonc", "vercel.json"].filter(existsSync)];
    expect(places.filter((f) => /futures-paper-worker|runFuturesPaperWorkerTick|futures_paper_commit_bar_v3/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
    // Scripts may run the worker's TESTS on a throwaway local server; none schedules anything for it.
    const scheduled = [...walk("scripts", /\.(ts|sh|sql)$/), ...walk("src", /\.(ts|tsx|sql)$/)].filter((f) => !f.includes(join("src", "test")))
      .filter((f) => { const t = readFileSync(f, "utf8"); return /cron\.schedule|create_http_schedule|net\.http_post/.test(t) && /futures.paper|futures_paper/.test(t); });
    expect(scheduled.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
