// Phase 4E follow-up change control (owner decisions of 13 Nov 2026): 0046 is NOT approved and stays an unapplied,
// byte-identical historical draft; 0047 stays permanently superseded; 0048 is approved for review/validation only and is
// unchanged and unapplied; the replacement draft 0049 exists only as a proposal; the engine and shadow modules are
// unchanged; the new modules are pure, reach nothing order-capable and are imported by nothing in the app; the
// authoritative backup identity is pinned and the identity checker tells the two stored exports and ZIP containers apart.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : []; }); }
function graph(entry: string) {
  const seen = new Set<string>([resolve(ROOT, entry)]), queue = [...seen];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = (m[1] ?? m[2])!;
      const base = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if (!base) { if (!/^((node:)?crypto|zod)$/.test(spec)) seen.add(`pkg:${spec}`); continue; }
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen].map((f) => (f.startsWith("pkg:") ? f : relative(ROOT, f)));
}
const NEW = ["src/lib/futures-paper-ledger-v3.ts", "src/lib/account-risk-budget.ts", "src/lib/retention-policy.ts"];
const FORBIDDEN = /futures\.server|futures-execution|futures-authorization|futures-lease|binance-futures|exchange-adapters|credential|crypto\.server|engine\.server|autopilot|wallet|ai-|integrations\/|manual\.server|arbitrage|deriv|paper\.server|\.functions|routes\/|central-risk-shadow|risk-limits|pkg:/;

describe("Phase 4F change control", () => {
  it("rejected 0046, superseded 0045/0047 and validation-stage 0048 are byte-identical to their recorded hashes", () => {
    expect(sha("docs/proposed-migrations/0045_futures_paper_ledger_and_strategy_budgets.sql")).toBe("fa907f33269f0b2ef583e161b37b7a79b1f3db084bcb6813a7b25dfbb021cf1b");
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.sql")).toBe("eac47d85843e9c1eaba249d7768ebec76e8c1c86c071bedf7fb5ca1a51b4623e");
    expect(sha("docs/proposed-migrations/0046_futures_paper_ledger_v2.rollback.sql")).toBe("dd8b96bafee966a28bd0bd51bec74678c463fe0ca6f6c75518733d88fc999453");
    expect(sha("docs/proposed-migrations/0047_futures_strategy_attribution.sql")).toBe("42d3c65e95c06775252d3cd0454581a3f70b803f690d22aab457f1d7e249801b");
    expect(sha("docs/proposed-migrations/0048_futures_strategy_attribution_v2.sql")).toBe("93305df74b2636e47f0464b9d57fd14d455ba15604d9b619c872fe61e0ba60bb");
    expect(sha("docs/proposed-migrations/0048_futures_strategy_attribution_v2.rollback.sql")).toBe("9930d14841197737a46b57ac845d08fc6ace840170693226e6586aac6fea504f");
  });
  it("0049 is a labelled draft that supersedes 0046; no draft is in the applied journal, which still ends at 0039", () => {
    const head = readFileSync("docs/proposed-migrations/0049_futures_paper_ledger_v3.sql", "utf8").slice(0, 600);
    expect(head).toMatch(/DRAFT ONLY\. NOT APPLIED/); expect(head).toMatch(/SUPERSEDES 0046 and 0045/);
    const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    expect(j.entries.some((e) => /^00(4\d)_/.test(e.tag))).toBe(false);
    expect(walk("drizzle/migrations", /\.sql$/).some((f) => /004\d_/.test(f))).toBe(false);
  });
  it("the engine and the Central Risk shadow modules are unchanged (no engine behaviour change in this phase)", () => {
    expect(sha("src/lib/futures-paper-engine.ts")).toBe("588d782d0e58bf2c6cafb7c29fb0f12c2f06f5366a352695a7f93718a263c3a9");
    expect(sha("src/lib/central-risk.ts")).toBe("0d1006bb06822a6749cacfeaf84b0533214aa6be3bc7f655467ae61fd2aace8d");
    expect(sha("src/lib/central-risk-shadow.ts")).toBe("76f27f3e2e8c3eff0cb11e27297cd26f7202f07062bb1e9878d17cdf103aa4cf");
    expect(sha("src/lib/central-risk-shadow.server.ts")).toBe("dda46802ad54f209c139ed48c1bdd0acfc5acefb6a16c57e4eb69ed6ca377037");
  });
});

describe("Phase 4F module isolation", () => {
  it("new modules are pure: no order, exchange, credential, wallet, Autopilot, AI, database, package or network import", () => {
    for (const f of NEW) expect(graph(f).filter((x) => x !== f && FORBIDDEN.test(x)), f).toEqual([]);
    for (const f of NEW) expect(readFileSync(f, "utf8"), f).not.toMatch(/fetch\(|supabase|process\.env|createServerFn|import\.meta\.env/);
  });
  it("nothing in the app imports them and no app code names the draft commit function", () => {
    // The later Phase 4F paper modules (aligned engine, disabled worker) use these modules; phase4f-alignment-isolation
    // proves nothing in the app imports THEM, so the set as a whole stays unreachable from the app.
    const PHASE_4F = ["src/lib/futures-paper-engine-v3.ts", "src/lib/futures-paper-worker.ts", "src/lib/futures-paper-worker-queries.ts"];
    const app = walk(resolve(ROOT, "src")).filter((f) => !f.includes(join("src", "test")) && !NEW.some((n) => f.endsWith(n)) && !PHASE_4F.some((n) => f.endsWith(n)));
    expect(app.filter((f) => /futures-paper-ledger-v3|account-risk-budget|retention-policy/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
    expect(app.filter((f) => /futures_paper_commit_bar_v3/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("authoritative backup identity", () => {
  const ID = JSON.parse(readFileSync("docs/phase-4e/authoritative-backup.json", "utf8")) as { sha256: string; sizeBytes: number; superseded: { sha256: string } };
  const run = (f: string) => spawnSync("bash", ["scripts/db-export/check-backup-identity.sh", f], { encoding: "utf8" });
  it("pins the verified 13 Nov 2026 export and the superseded 12 Nov export", () => {
    expect(ID.sha256).toBe("448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5"); expect(ID.sizeBytes).toBe(2525322);
    expect(ID.superseded.sha256).toBe("7af876652ee97596afea1736f11f170cc23d11c474c0927a077e776da3276634");
    expect(readFileSync("docs/phase-4e/authoritative-backup.sha256", "utf8")).toMatch(new RegExp(`^${ID.sha256}  orbit-trade-copilot_261113\\.backup`));
  });
  it("the checker reports a different file and a ZIP container as DIFFERENT and refuses URLs", () => {
    const d = mkdtempSync(join(tmpdir(), "bkid-")); writeFileSync(join(d, "x.backup"), "PGDMP not the backup"); writeFileSync(join(d, "x.zip"), "PK\u0003\u0004 zip");
    expect(run(join(d, "x.backup")).status).toBe(1);
    const z = run(join(d, "x.zip")); expect(z.status).toBe(1); expect(z.stdout).toMatch(/ZIP container/);
    expect(run("https://example.com/x.backup").status).toBe(2);
  });
});
