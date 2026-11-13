// Phase 4H finalization change control: drafts 0049, 0050 and 0051 (and their rollbacks) stay byte-identical; the
// successor drafts 0052/0053 and their rollbacks are pinned and unapplied; 0052 replaces 0049's commit with 0049's body
// changed in exactly two declared places and the gateway with 0051's body calling v5; both rollbacks restore the prior
// bodies byte-for-byte; nothing in the app, scripts, drizzle or supabase references the new objects (only the disabled
// identity mapping names its six wrappers); the identity binding never touches the service key; nothing is scheduled.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = (f: string) => readFileSync(f, "utf8");
function walk(dir: string, re = /\.(ts|tsx)$/): string[] { return existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []; }
const D = "docs/proposed-migrations/";
const fn = (src: string, head: string) => { const i = src.indexOf(head); expect(i, head).toBeGreaterThanOrEqual(0); return src.slice(i, src.indexOf("END $$;", i) + "END $$;".length); };

describe("Phase 4H finalization change control", () => {
  it("0049/0050/0051 and their rollbacks keep their Phase 4H fingerprints; 0052/0053 and their rollbacks are pinned", () => {
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
    };
    for (const [f, h] of Object.entries(pins)) expect(sha(D + f), f).toBe(h);
  });
  it("0052's v3 is 0049's body changed in exactly two places; its gateway is 0051's calling v5; the rollback restores both bodies", () => {
    const m49 = read(D + "0049_futures_paper_ledger_v3.sql"), m51 = read(D + "0051_futures_paper_event_completeness.sql");
    const m52 = read(D + "0052_futures_paper_entry_completeness_and_exit_only.sql"), r52 = read(D + "0052_futures_paper_entry_completeness_and_exit_only.rollback.sql");
    const v3of49 = fn(m49, "CREATE FUNCTION public.futures_paper_commit_bar_v3(").replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    const STOP_49 = "  IF a.status = 'stopped' THEN RAISE EXCEPTION 'futures paper account is stopped'; END IF;\n";
    const STOP_52 = "  IF a.status = 'stopped' AND NOT EXISTS (SELECT 1 FROM public.futures_paper_positions WHERE account_id = a.id)\n     AND NOT EXISTS (SELECT 1 FROM public.futures_paper_risk_approvals WHERE account_id = a.id AND status = 'open') THEN\n    RAISE EXCEPTION 'futures paper account is stopped';  -- 0052 (decision B): a stopped account with exposure commits exit-only candles\n  END IF;\n";
    const CANCEL = "      UPDATE public.futures_paper_risk_approvals SET status = 'cancelled', closed_seq = v_seq + 1 WHERE account_id = a.id AND proposal_id = v_prop;\n";
    const VERIFY = "      PERFORM public.fp5_verify_fill_refusal(a.id, r.proposal_id, p_bar_t, v_t, cs, v_wallet, public.fp2_txt(e, 'reason', false));  -- 0052 (decision A)\n";
    expect(fn(m52, "CREATE OR REPLACE FUNCTION public.futures_paper_commit_bar_v3(")).toBe(v3of49.replace(STOP_49, STOP_52).replace(CANCEL, VERIFY + CANCEL));
    expect(fn(r52, "CREATE OR REPLACE FUNCTION public.futures_paper_commit_bar_v3(")).toBe(v3of49);
    const gw51 = fn(m51, "CREATE OR REPLACE FUNCTION public.fpw_commit(");
    expect(fn(m52, "CREATE OR REPLACE FUNCTION public.fpw_commit(")).toBe(gw51.replace("futures_paper_commit_bar_v4(p_account", "futures_paper_commit_bar_v5(p_account"));
    expect(fn(r52, "CREATE OR REPLACE FUNCTION public.fpw_commit(")).toBe(gw51);
  });
  it("no draft is applied: the journal ends at 0039; nothing outside tests references 0052/0053 objects except the disabled identity mapping", () => {
    const j = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    const re = /futures_paper_commit_bar_v5|futures_paper_entry_checks|futures_paper_config_changes|fp5_|fpw_id_|fpw_admin_set_identity|fpw_owner_enroll|futures_paper_worker_identities|futures_paper_worker_enrollments/;
    const places = [...walk("drizzle", /./), ...walk("supabase", /./), ...walk("src", /\.(ts|tsx)$/).filter((f) => !f.includes(join("src", "test"))), ...walk("scripts", /\.(ts|sh|sql)$/)];
    const allowed = new Set(["src/lib/futures-paper-worker-identity.ts", "scripts/db-export/verify-local-restore-0052.sh", "scripts/db-export/verify-local-restore-0054.sh"]); // 0054: Phase 4H.1 verifier
    expect(places.filter((f) => re.test(read(f))).map((f) => relative(process.cwd(), f)).filter((f) => !allowed.has(f))).toEqual([]);
  });
  it("the signed-in identity binding is disabled, never uses the service key and is imported by nothing in the app", () => {
    const srv = read("src/lib/futures-paper-worker-identity.server.ts");
    expect(srv).not.toMatch(/client\.server|supabaseAdmin|SERVICE_ROLE|service_role/);
    expect(srv).toMatch(/FUTURES_PAPER_WORKER_HOSTED"\] !== "enabled" \|\| process\.env\["FUTURES_PAPER_WORKER_IDENTITY"\] !== "signed-in"/);
    expect(srv).not.toMatch(/console\.|\.log\(/);
    const importers = walk("src").filter((f) => !f.includes(join("src", "test")) && !f.endsWith("futures-paper-worker-identity.server.ts") && /futures-paper-worker-identity/.test(read(f)));
    expect(importers.map((f) => relative(process.cwd(), f))).toEqual([]);
    const flags = walk("src").filter((f) => !f.includes(join("src", "test")) && /FUTURES_PAPER_WORKER_IDENTITY|FUTURES_PAPER_WORKER_EMAIL|FUTURES_PAPER_WORKER_PASSWORD/.test(read(f)));
    expect(flags.map((f) => relative(process.cwd(), f))).toEqual(["src/lib/futures-paper-worker-identity.server.ts"]);
    for (const f of [".env", "wrangler.jsonc", "wrangler.toml"].filter(existsSync)) expect(read(f)).not.toMatch(/FUTURES_PAPER_WORKER_(HOSTED|IDENTITY)/);
  });
  it("the Phase 4G hosted connection is unchanged and no route or schedule reaches any paper worker", () => {
    expect(sha("src/lib/futures-paper-worker-hosted.ts")).toBe("1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824");
    expect(sha("src/lib/futures-paper-worker-hosted.server.ts")).toBe("09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5");
    const routes = walk("src/routes").filter((f) => /futures-paper-worker|runFuturesPaperWorkerTick|runHostedFuturesPaperWorkerTick/.test(read(f)));
    expect(routes).toEqual([]);
  });
});
