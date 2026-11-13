// Phase 4G change control: Phase 4F code is byte-identical; 0049 and earlier drafts are unchanged; draft 0050 is pinned
// and unapplied; the hosted connection is OFF (code flag + unset environment flag), imported by nothing in the app,
// reachable from no route/cron/schedule, holds no credential of its own, and the real order paths cannot reach it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_WORKER_ENABLED_BY_DEFAULT } from "@/lib/futures-paper-worker-hosted";
import { hostedFuturesPaperRpc } from "@/lib/futures-paper-worker-hosted.server";

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
      if (!base) { seen.add(`pkg:${spec}`); continue; }
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => (f.startsWith("pkg:") ? f : relative(ROOT, f)));
}
const G = ["src/lib/futures-paper-worker-hosted.ts", "src/lib/futures-paper-worker-hosted.server.ts", "src/lib/futures-paper-market-provenance.ts"];

describe("Phase 4G change control", () => {
  it("Phase 4F modules are byte-identical to the Phase 4F commit", () => {
    const pins: Record<string, string> = {
      "src/lib/futures-paper-worker.ts": "1e88149683c5e06459db7e07ba4c7ad8ccef3f055d938d2013ba1fb792435947",
      "src/lib/futures-paper-engine-v3.ts": "4e507828bfb32110399c755b840863a0392fb27eeecc471064478bd42267c313",
      "src/lib/futures-paper-market-data.ts": "3ab8edacaa167186e82ed741d4069efe66b9ca4f31fcd1242d0aa10e5eb971cb",
      "src/lib/futures-paper-worker-queries.ts": "fca2f3b0f78ef9a685dd87d5e926e8dd1a03684186c38ed9dc043c2f1c9dd0de",
      "src/lib/futures-paper-engine.ts": "588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9",
      "docs/proposed-migrations/0049_futures_paper_ledger_v3.sql": "fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35",
      "docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql": "e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb",
      "docs/proposed-migrations/0050_futures_paper_worker_gateway.sql": "40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa",
      "docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql": "93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b",
    };
    for (const [f, h] of Object.entries(pins)) expect(sha(f), f).toBe(h);
  });
  it("no draft is applied: the journal still ends at 0039 and no 004x/005x or paper object is in drizzle or supabase", () => {
    const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    expect([...walk("drizzle", /\.sql$/), ...walk("supabase", /\.sql$/)].filter((f) => /00[45]\d_|futures_paper|fpw_|risk_approval/.test(f) || /fpw_|futures_paper/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("the hosted connection is disabled and isolated", () => {
  it("is off by default; the server binding refuses without the (unset) environment flag", async () => {
    expect(HOSTED_WORKER_ENABLED_BY_DEFAULT).toBe(false);
    expect(process.env["FUTURES_PAPER_WORKER_HOSTED"]).toBeUndefined();
    await expect(hostedFuturesPaperRpc()).rejects.toThrow(/disabled/);
    for (const f of [".env", ".env.example", "wrangler.toml", "wrangler.jsonc", "supabase/config.toml"].filter(existsSync)) expect(readFileSync(f, "utf8"), f).not.toMatch(/FUTURES_PAPER_WORKER_HOSTED/);
  });
  it("nothing in the app imports the Phase 4G modules; no route, cron entry or schedule names them or the gateway functions", () => {
    const app = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && !G.some((g) => f.endsWith(g)));
    expect(app.filter((f) => /futures-paper-worker-hosted|futures-paper-market-provenance|fpw_/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
    const places = [...walk("src/routes", /./), ...walk("supabase", /./), ...walk("scripts", /\.(ts|sh|sql)$/), ...["wrangler.toml", "wrangler.jsonc", "vercel.json"].filter(existsSync)];
    expect(places.filter((f) => /cron|schedule|http_post|setInterval/.test(readFileSync(f, "utf8")) && /fpw_|futures-paper-worker-hosted|runHostedFuturesPaperWorkerTick/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
    for (const f of ["src/lib/futures.server.ts", "src/lib/futures-execution.ts", "src/lib/engine.server.ts", "src/lib/autopilot-tools.server.ts", "src/lib/autopilot-runner.server.ts", "src/lib/paper.server.ts", "src/lib/manual.server.ts", "src/lib/binance-futures-core.server.ts"].filter(existsSync)) {
      expect(graph(f).filter((x) => G.includes(x)), f).toEqual([]);
    }
  });
  it("the pure modules reach only the paper worker stack; no network, environment, database client, exchange or AI access", () => {
    const allowed = new Set([...G, "src/lib/futures-paper-worker.ts", "src/lib/futures-paper-engine-v3.ts", "src/lib/futures-paper-engine.ts", "src/lib/futures-paper-market-data.ts", "src/lib/central-risk.ts", "src/lib/account-risk-budget.ts", "src/lib/futures-paper-ledger-v3.ts", "pkg:zod"]);
    for (const f of ["src/lib/futures-paper-worker-hosted.ts", "src/lib/futures-paper-market-provenance.ts"]) {
      expect(graph(f).filter((x) => !allowed.has(x)), f).toEqual([]);
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bfetch\(|supabase|process\.env|import\.meta\.env|createServerFn|new WebSocket|setInterval|console\.|\/fapi\/|SERVICE_ROLE/);
    }
  });
  it("the server binding keeps the credential inside the generated client: no key name, no logging, allowlist enforced", () => {
    const src = readFileSync("src/lib/futures-paper-worker-hosted.server.ts", "utf8");
    expect(src).not.toMatch(/SERVICE_ROLE|SUPABASE_URL|apikey|Authorization|console\.|\bfetch\(/i);
    expect(src).toMatch(/process\.env\["FUTURES_PAPER_WORKER_HOSTED"\] !== "enabled"/);
    expect(src).toMatch(/HOSTED_WORKER_RPCS as readonly string\[\]\)\.includes\(fn\)/);
    expect(graph("src/lib/futures-paper-worker-hosted.server.ts").filter((x) => x.startsWith("src/integrations/") || x.startsWith("pkg:")).sort())
      .toEqual(expect.arrayContaining(["src/integrations/supabase/client.server.ts"]));
  });
});
