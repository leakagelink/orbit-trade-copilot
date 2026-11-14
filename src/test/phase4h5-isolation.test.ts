// Phase 4H.5 change control: drafts 0049–0054 unchanged (phase4h2-isolation pins them), 0055/0056 pinned here, each a
// single atomic statement that deletes no data, nothing applied (applied history still ends at 0039), the locked
// Phase 4G hosted file unchanged, the checkpoint module pure and unused by the app, no route/schedule/flag added.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = (f: string) => readFileSync(f, "utf8");
const walk = (d: string, re = /\.(ts|tsx)$/): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []);
const D = "docs/proposed-migrations/";
export const PINS_4H5: Record<string, string> = {
  "0055_futures_paper_worker_security_remediation.sql": "b157a84482d35d98a7069f2c4dcb3f173211fa845a1985c929dd3513733ca3f7",
  "0055_futures_paper_worker_security_remediation.rollback.sql": "e05e410751d373f34201e05fc9be95848830d4c7b73c2778cb69ced5bcd15a17",
  "0056_worker_identity_api_boundary.sql": "55d20793cef1cdf35f272764df047e92ecf26274283484d3df58180437106340",
  "0056_worker_identity_api_boundary.rollback.sql": "dc8fbaa49e39c67136863c4e35eb542ffd7c669bd346c70424d9241e1970d6ee",
};
const body = (f: string) => read(D + f).replace(/--.*$/gm, "").trim(); // comments removed (none of these files has "--" inside a string)

describe("Phase 4H.5 change control", () => {
  it("the four new draft files are pinned; nothing was applied (applied history still ends at drizzle 0039)", () => {
    for (const [f, h] of Object.entries(PINS_4H5)) expect(sha(D + f), f).toBe(h);
    const j = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
    expect(readdirSync("drizzle/migrations").filter((f) => /^(\d{4})_/.test(f) && Number(f.slice(0, 4)) > 39)).toEqual([]);
  });
  it("each draft and rollback is ONE statement (a single DO block), so it applies all-or-nothing; none contains transaction control", () => {
    for (const f of Object.keys(PINS_4H5)) {
      const b = body(f), tag = /^DO (\$[a-z]+\$)/.exec(b)?.[1];
      expect(tag, f).toBeDefined();
      expect(b.endsWith(`${tag};`), f).toBe(true);
      expect(b.split(tag!).length, f).toBe(3);
      expect(b, f).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    }
  });
  it("no draft or rollback deletes history: no DROP TABLE, TRUNCATE or unconditional DELETE; the 0055 rollback renames the refusal table", () => {
    for (const f of Object.keys(PINS_4H5)) expect(body(f), f).not.toMatch(/\bDROP\s+TABLE\b|^\s*TRUNCATE\b|\bDELETE\s+FROM\b|\bCASCADE\b/im);
    expect(body("0055_futures_paper_worker_security_remediation.rollback.sql")).toMatch(/RENAME TO futures_paper_worker_refusals_0055_retired/);
  });
  it("every SECURITY DEFINER function in 0055/0056 fixes its search_path", () => {
    for (const f of ["0055_futures_paper_worker_security_remediation.sql", "0056_worker_identity_api_boundary.sql"]) {
      const fns = body(f).split(/CREATE (?:OR REPLACE )?FUNCTION /).slice(1);
      expect(fns.length, f).toBeGreaterThan(0);
      for (const fn of fns) { const head = fn.slice(0, fn.indexOf(" AS ")); if (/SECURITY DEFINER/.test(head)) expect(head, fn.slice(0, 40)).toMatch(/SET search_path/); }
    }
  });
  it("the locked Phase 4G hosted connection is byte-identical (the L7 fix lives in the session module)", () => {
    expect(sha("src/lib/futures-paper-worker-hosted.ts")).toBe("1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824");
    expect(sha("src/lib/futures-paper-worker-hosted.server.ts")).toBe("09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5");
  });
  it("the checkpoint module is pure and nothing in the app imports it; no route, schedule or flag reaches the worker or checkpoints", () => {
    const src = read("src/lib/audit-checkpoint.ts");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/\bfetch\(|process\.env|import\.meta\.env|supabase|createServerFn|setTimeout|setInterval|console\.|localStorage/);
    const app = walk("src").filter((f) => !f.includes(join("src", "test"))).map((f) => relative(process.cwd(), f));
    expect(app.filter((f) => f !== "src/lib/audit-checkpoint.ts" && /audit-checkpoint/.test(read(f)))).toEqual([]);
    const places = [...walk("src/routes", /./), ...walk("supabase", /./), ...walk("scripts", /\.(ts|sh|sql)$/)];
    expect(places.filter((f) => /fpw_id2_|fpw_audit_checkpoint|audit-checkpoint|fpw_api_pre_request/.test(read(f)) && /cron\.schedule|create_http_schedule|net\.http_post|createFileRoute|setInterval/.test(read(f))).map((f) => relative(process.cwd(), f))).toEqual([]);
    for (const k of ["FUTURES_PAPER_WORKER_HOSTED", "FUTURES_PAPER_WORKER_IDENTITY", "FUTURES_PAPER_WORKER_EMAIL", "FUTURES_PAPER_WORKER_PASSWORD", "FUTURES_PAPER_WORKER_USER_ID"]) expect(process.env[k], k).toBeUndefined();
  });
  it("the offline checkpoint tool reads local files only (no database client, network or environment)", () => {
    const s = read("scripts/audit-checkpoint/audit-checkpoints.ts");
    expect(s).not.toMatch(/postgres|supabase|fetch\(|process\.env|https?:\/\//);
    expect([...s.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["node:fs", "../../src/lib/audit-checkpoint"]);
  });
});
