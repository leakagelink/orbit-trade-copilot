// Phase 4H.1 change control: drafts 0049–0053 and their rollbacks stay byte-identical; successor draft 0054 and its
// rollback are pinned and unapplied; 0054's rollback restores the seven replaced 0053 functions byte-for-byte (text
// level here; catalog level in migration-0054-identity-lifecycle.test.ts and the local restore verifier); 0054 grants
// nothing to PUBLIC/anon/service_role; nothing in the app, routes, drizzle or supabase references 0054 objects; the
// worker activation flags remain unset and no route or schedule reaches the worker.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = (f: string) => readFileSync(f, "utf8");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []; }
const D = "docs/proposed-migrations/";
const code = (src: string) => src.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n"); // SQL without comments
const fn = (src: string, head: string) => { const i = src.indexOf(head); expect(i, head).toBeGreaterThanOrEqual(0); return src.slice(i, src.indexOf("END $$;", i) + "END $$;".length); };

describe("Phase 4H.1 change control", () => {
  it("0049–0053 and their rollbacks keep their Phase 4H fingerprints; 0054 and its rollback are pinned", () => {
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
  });
  it("0054's rollback re-creates exactly the seven replaced 0053 function texts and drops only 0054 objects", () => {
    const m53 = read(D + "0053_futures_paper_worker_identity.sql"), r54 = read(D + "0054_futures_paper_worker_identity_lifecycle.rollback.sql");
    const names = ["fpw_admin_set_identity", "fpw_owner_enroll", "fpw_id_authorize", "fpw_id_acquire_lease", "fpw_id_release_lease", "fpw_id_commit", "fpw_id_mark_review"];
    for (const n of names) expect(fn(r54, `CREATE OR REPLACE FUNCTION public.${n}(`), n).toBe(fn(m53, `CREATE FUNCTION public.${n}(`).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
    expect((r54.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(7);
    expect(r54.match(/^DROP .*$/gm)).toEqual(["DROP VIEW public.futures_paper_0054_requires_0053;", "DROP FUNCTION public.fpw_id_check(uuid, boolean);", "DROP TABLE public.futures_paper_worker_identity_changes;"]);
    expect(code(r54)).not.toMatch(/GRANT|CASCADE/);
  });
  it("0054 grants nothing to PUBLIC, anon or service_role, uses no CASCADE and replaces only 0053 functions", () => {
    const m54 = read(D + "0054_futures_paper_worker_identity_lifecycle.sql");
    for (const g of code(m54).match(/^GRANT[\s\S]*?;/gm) ?? []) expect(g).toMatch(/TO authenticated;$/);
    expect(code(m54)).not.toMatch(/CASCADE|SECURITY INVOKER|ALTER DEFAULT PRIVILEGES|DROP /);
    const replaced = [...m54.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((x) => x[1]).sort();
    expect(replaced).toEqual(["fpw_admin_set_identity", "fpw_id_acquire_lease", "fpw_id_authorize", "fpw_id_commit", "fpw_id_mark_review", "fpw_id_release_lease", "fpw_owner_enroll"]);
    expect([...m54.matchAll(/^CREATE FUNCTION public\.(\w+)\(/gm)].map((x) => x[1])).toEqual(["fpw_id_check"]);
    for (const head of m54.match(/^CREATE (OR REPLACE )?FUNCTION[^\n]*\n[^\n]*/gm) ?? []) expect(head).toMatch(/SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS \$\$$/);
  });
  it("no draft is applied and nothing outside tests and local scripts references 0054 objects; activation flags stay unset", () => {
    const j = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    const re = /fpw_id_check|futures_paper_worker_identity_changes|futures_paper_0054_requires_0053|0054_futures_paper/;
    const places = [...walk("drizzle", /./), ...walk("supabase", /./), ...walk("src", /\.(ts|tsx)$/).filter((f) => !f.includes(join("src", "test")))];
    expect(places.filter((f) => re.test(read(f))).map((f) => relative(process.cwd(), f))).toEqual([]);
    for (const f of [".env", "wrangler.jsonc", "wrangler.toml", "vercel.json"].filter(existsSync)) expect(read(f)).not.toMatch(/FUTURES_PAPER_WORKER_(HOSTED|IDENTITY|EMAIL|PASSWORD)/);
    expect(walk("src/routes").filter((f) => /futures-paper-worker|runHostedFuturesPaperWorkerTick|identityFuturesPaperRpc/.test(read(f)))).toEqual([]);
    const sched = [...walk("supabase", /./), ...walk("scripts", /\.(ts|sh|sql)$/)].filter((f) => /cron\.schedule|create_http_schedule|net\.http_post/.test(read(f)) && /fpw_|futures-paper-worker/.test(read(f)));
    expect(sched).toEqual([]);
  });
});
