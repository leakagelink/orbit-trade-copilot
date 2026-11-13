// Phase 4H change control: drafts 0049 and 0050 are byte-identical (G2 is fixed in the successor draft 0051, never in
// place); 0051 and its rollback are pinned and unapplied; no application code, route or schedule references the v4
// commit or the new tables; the hosted connection (Phase 4G) is unchanged and still disabled.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []; }

describe("Phase 4H change control", () => {
  it("0049/0050 (and their rollbacks) keep their Phase 4G fingerprints; 0051 is pinned", () => {
    const pins: Record<string, string> = {
      "docs/proposed-migrations/0049_futures_paper_ledger_v3.sql": "fe4dd56c3f7542af6b9291d9ac33496892bca32d331821c05c2c3460a3abcd35",
      "docs/proposed-migrations/0049_futures_paper_ledger_v3.rollback.sql": "e593132115eeb6cbaafcb1f1d5011f6d508816dbfc1095f644c47e63941fb5fb",
      "docs/proposed-migrations/0050_futures_paper_worker_gateway.sql": "40c2fdbf9bfbef3896dee5a3f6049cd35abf50a690a5fb1e20bc855d5fa4c0fa",
      "docs/proposed-migrations/0050_futures_paper_worker_gateway.rollback.sql": "93197b8c39b84c5858541335816679ab45369323edb3f51fb4b427f356aa346b",
      "docs/proposed-migrations/0051_futures_paper_event_completeness.sql": "58828556c8709a9c7c4cbe64b5e6643af211db2e99e5a54c9ac6c7cb6280b788",
      "docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql": "41d1aa85f48621842a6f04a2a195d3800eeb2c7b766e0cedd5d30f057c0d94cf",
      "src/lib/futures-paper-worker-hosted.ts": "1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824",
      "src/lib/futures-paper-worker-hosted.server.ts": "09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5",
      "src/lib/futures-paper-market-provenance.ts": "8c92f17e45165d302fd765b85ae8a2ab75754020d02bde472510ca4dfd45ce1d",
    };
    for (const [f, h] of Object.entries(pins)) expect(sha(f), f).toBe(h);
  });
  it("0051's gateway body is 0050's body with only the called commit function changed; its rollback restores 0050's body", () => {
    const body = (s: string) => { const i = s.indexOf("FUNCTION public.fpw_commit("); return s.slice(i, s.indexOf("END $$;", i)); };
    const m50 = body(readFileSync("docs/proposed-migrations/0050_futures_paper_worker_gateway.sql", "utf8"));
    const m51 = body(readFileSync("docs/proposed-migrations/0051_futures_paper_event_completeness.sql", "utf8"));
    const r51 = body(readFileSync("docs/proposed-migrations/0051_futures_paper_event_completeness.rollback.sql", "utf8"));
    expect(m51).toBe(m50.replace("futures_paper_commit_bar_v3(p_account", "futures_paper_commit_bar_v4(p_account"));
    expect(r51).toBe(m50);
  });
  it("no draft is applied: the journal ends at 0039; nothing in drizzle/supabase or the app references 0051 objects", () => {
    const j = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    const re = /futures_paper_commit_bar_v4|futures_paper_protection_terms|futures_paper_candle_checks|fp4_/;
    const places = [...walk("drizzle", /./), ...walk("supabase", /./), ...walk("src", /\.(ts|tsx)$/).filter((f) => !f.includes(join("src", "test"))), ...walk("scripts", /\.(ts|sh|sql)$/)];
    expect(places.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
