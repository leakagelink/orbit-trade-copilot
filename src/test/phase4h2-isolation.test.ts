// Phase 4H.2 change control and code-level isolation (layer B). Drafts 0049–0054 and their rollbacks are byte-identical
// (no successor draft was needed); the Phase 4G hosted connection is unchanged; the new token-lifecycle module is pure;
// the signed-in binding uses no client library, no privileged key and no background timers; the worker's whole import
// graph cannot reach exchange, wallet, credential, order, Autopilot, AI or admin-client modules, and none of those
// modules can reach the worker; nothing in the app, routes or schedules reaches the binding; activation flags are unset.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = (f: string) => readFileSync(f, "utf8");
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
const D = "docs/proposed-migrations/";
const SESSION = "src/lib/worker-auth-session.ts", BINDING = "src/lib/futures-paper-worker-identity.server.ts";

describe("Phase 4H.2 change control", () => {
  it("drafts 0049–0054 and their rollbacks are byte-identical to Phase 4H.1; no successor draft exists", () => {
    const pins: Record<string, string> = {
      "0049_futures_paper_ledger_v3.sql": "fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35",
      "0049_futures_paper_ledger_v3.rollback.sql": "e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb",
      "0050_futures_paper_worker_gateway.sql": "40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa",
      "0050_futures_paper_worker_gateway.rollback.sql": "93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b",
      "0051_futures_paper_event_completeness.sql": "58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788",
      "0051_futures_paper_event_completeness.rollback.sql": "41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf",
      "0052_futures_paper_entry_completeness_and_exit_only.sql": "e6ed1a01ca93e71cbf680edde7000be724621e0f81a1aae96aaf3886b4ef40d9",
      "0052_futures_paper_entry_completeness_and_exit_only.rollback.sql": "562128f7033b21238af5fe54e78fbde0d7bea4438cfaa8a5e1b892f938ad84d3",
      "0053_futures_paper_worker_identity.sql": "d436091177e43ab5bab3522fad29e633561966e9c6b6b1a370b3553f1d48d2bf",
      "0053_futures_paper_worker_identity.rollback.sql": "11fec84bcca216a11ae581b1e36d2268742981c8a23e726356328cb0b41923d2",
      "0054_futures_paper_worker_identity_lifecycle.sql": "391beac68e7de77112542f7c84b2b58628bf634fc39c8ee56a670532d3c47177",
      "0054_futures_paper_worker_identity_lifecycle.rollback.sql": "4e78cebeedf8794859206013b22b178aabb08e375dd52478a97cc0ec12d34569",
    };
    for (const [f, h] of Object.entries(pins)) expect(sha(D + f), f).toBe(h);
    // Phase 4H.5 adds exactly the successor drafts 0055 and 0056 (pinned in phase4h5-isolation.test.ts); nothing else.
    expect(readdirSync(D).filter((f) => /^(\d{4})_/.test(f) && Number(f.slice(0, 4)) > 54).sort()).toEqual([
      "0055_futures_paper_worker_security_remediation.rollback.sql", "0055_futures_paper_worker_security_remediation.sql",
      "0056_worker_identity_api_boundary.rollback.sql", "0056_worker_identity_api_boundary.sql",
    ]);
    const j = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
  });
  it("the Phase 4G hosted connection and its service binding are unchanged", () => {
    expect(sha("src/lib/futures-paper-worker-hosted.ts")).toBe("1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824");
    expect(sha("src/lib/futures-paper-worker-hosted.server.ts")).toBe("09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5");
  });
});

describe("Phase 4H.2 token lifecycle code (layer B)", () => {
  it("the lifecycle module is pure: no imports, network, environment, database client, timers loop or logging", () => {
    expect(graph(SESSION)).toEqual([SESSION]);
    expect(read(SESSION)).not.toMatch(/\bfetch\(|process\.env|import\.meta\.env|supabase|createServerFn|setInterval|console\.|localStorage|WebSocket/);
  });
  it("the signed-in binding uses plain fetch with refused redirects, local-scope sign-out, no client library, no privileged key and no logging", () => {
    const src = read(BINDING);
    expect(src).not.toMatch(/@supabase\/supabase-js|createClient|autoRefreshToken|persistSession|client\.server|supabaseAdmin|SERVICE_ROLE|service_role|console\.|setInterval/);
    expect(src).toMatch(/logout\?scope=local/);
    expect(src.match(/redirect: "error"/g)).toHaveLength(2);
    expect(src).toMatch(/runWithWorkerSession\(/);
    expect(graph(BINDING).sort()).toEqual([
      BINDING, "src/lib/account-risk-budget.ts", "src/lib/central-risk.ts", "src/lib/futures-paper-engine-v3.ts", "src/lib/futures-paper-engine.ts",
      "src/lib/futures-paper-ledger-v3.ts", "src/lib/futures-paper-market-data.ts", "src/lib/futures-paper-market-provenance.ts",
      "src/lib/futures-paper-worker-hosted.ts", "src/lib/futures-paper-worker-identity.ts", "src/lib/futures-paper-worker.ts", SESSION, "pkg:zod",
    ].sort());
  });
  it("no worker module can reach exchange, wallet, credential, order, Autopilot, AI, bot, admin-client or server-function modules", () => {
    const FORBIDDEN = /exchange|wallet|credential|crypto\.server|binance|deriv|okx|bybit|oanda|order|autopilot|engine\.server|manual\.server|futures\.server|futures-execution|arbitrage|ai-|research|bot|client\.server|\.functions|supabase/;
    const worker = [BINDING, SESSION, "src/lib/futures-paper-worker-identity.ts", "src/lib/futures-paper-worker-hosted.ts", "src/lib/futures-paper-worker.ts"];
    for (const f of worker) expect(graph(f).filter((x) => x !== f && FORBIDDEN.test(x)), f).toEqual([]);
    // The Phase 4G service binding reaches the admin client by design; it stays disabled and is imported by nothing (phase4g-isolation).
    expect(graph("src/lib/futures-paper-worker-hosted.server.ts")).toContain("src/integrations/supabase/client.server.ts");
  });
  it("no execution, wallet, credential or Autopilot module can reach the worker or the lifecycle module", () => {
    const exec = walk("src/lib").map((f) => relative(ROOT, f)).filter((f) => /exchange|wallet|credential|crypto\.server|binance|deriv|order|autopilot|engine\.server|manual\.server|futures\.server|futures-execution|arbitrage/.test(f));
    expect(exec.length).toBeGreaterThan(20);
    for (const f of exec) expect(graph(f).filter((x) => x === SESSION || /futures-paper-worker/.test(x)), f).toEqual([]);
  });
  it("nothing in the app imports the lifecycle module except the disabled binding; no route or schedule reaches either; flags are unset", () => {
    const app = walk("src").filter((f) => !f.includes(join("src", "test"))).map((f) => relative(ROOT, f));
    expect(app.filter((f) => f !== SESSION && /worker-auth-session/.test(read(f)))).toEqual([BINDING]);
    expect(app.filter((f) => f !== BINDING && /runIdentityFuturesPaperTick|identityTransports|futures-paper-worker-identity\.server/.test(read(f)))).toEqual([]);
    const places = [...walk("src/routes", /./), ...walk("supabase", /./), ...walk("scripts", /\.(ts|sh|sql)$/), ...["wrangler.toml", "wrangler.jsonc", "vercel.json"].filter(existsSync)];
    expect(places.filter((f) => /runIdentityFuturesPaperTick|worker-auth-session|futures-paper-worker|fpw_id_/.test(read(f)) && /cron\.schedule|create_http_schedule|net\.http_post|createFileRoute|setInterval/.test(read(f))).map((f) => relative(ROOT, f))).toEqual([]);
    for (const k of ["FUTURES_PAPER_WORKER_HOSTED", "FUTURES_PAPER_WORKER_IDENTITY", "FUTURES_PAPER_WORKER_EMAIL", "FUTURES_PAPER_WORKER_PASSWORD"]) expect(process.env[k], k).toBeUndefined();
    for (const f of [".env", ".env.example", "wrangler.jsonc", "wrangler.toml", "supabase/config.toml"].filter(existsSync)) expect(read(f), f).not.toMatch(/FUTURES_PAPER_WORKER_/);
  });
});
