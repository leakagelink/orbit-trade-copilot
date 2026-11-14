// Phase 4H.7 change control: drafts 0049–0056 unchanged (pinned by phase4h2/phase4h5-isolation), 0057 pinned here and a
// single atomic statement that deletes no data; nothing applied (journal ends at 0039); the locked Phase 4G hosted files
// unchanged; the two new modules are pure, import nothing and are imported only by the disabled binding; no route,
// schedule or environment flag reaches the bounded invocation.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = (f: string) => readFileSync(f, "utf8");
const walk = (d: string, re = /\.(ts|tsx)$/): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".git" ? [] : walk(p, re)) : re.test(n) ? [p] : []; }) : []);
const D = "docs/proposed-migrations/";
export const PINS_4H7: Record<string, string> = {
  "0057_worker_credential_pin_and_refusal_tally.sql": "49353babb0b77114970b0f9a70162f4adc8f6fa34b0008b7d28be0ceb04d21e0",
  "0057_worker_credential_pin_and_refusal_tally.rollback.sql": "9275ce3be0340e4be0722d3fa62b3022d3bf57f680efcf5ae99b6ebe71f714e6",
};
const body = (f: string) => read(D + f).replace(/--.*$/gm, "").trim();
const NEW = ["src/lib/worker-invocation.ts", "src/lib/worker-refusal-audit.ts"];

describe("Phase 4H.7 change control", () => {
  it("0057 and its rollback are pinned; nothing is applied (journal ends at drizzle 0039)", () => {
    for (const [f, h] of Object.entries(PINS_4H7)) expect(sha(D + f), f).toBe(h);
    const j = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(j.entries.at(-1)!.tag).toBe("0039_futures_pass_certification_and_autopilot_fencing");
  });
  it("each is ONE statement (a single DO block) without transaction control; no DROP TABLE, TRUNCATE, DELETE or CASCADE", () => {
    for (const f of Object.keys(PINS_4H7)) {
      const b = body(f), tag = /^DO (\$[a-z]+\$)/.exec(b)?.[1];
      expect(tag, f).toBeDefined();
      expect(b.endsWith(`${tag};`), f).toBe(true);
      expect(b.split(tag!).length, f).toBe(3);
      expect(b, f).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
      expect(b, f).not.toMatch(/\bDROP\s+TABLE\b|^\s*TRUNCATE\b|\bDELETE\s+FROM\b|\bCASCADE\b/im);
    }
    expect(body("0057_worker_credential_pin_and_refusal_tally.rollback.sql").match(/RENAME TO futures_paper_worker_\w+_0057_retired/g)).toHaveLength(3);
  });
  it("0057 writes nothing to auth.* and changes no auth setting; every SECURITY DEFINER function fixes its search_path", () => {
    const b = body("0057_worker_credential_pin_and_refusal_tally.sql");
    expect(b).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+auth\./i);
    expect(b).not.toMatch(/ALTER\s+ROLE|pgrst\.|auth\.config|ALTER\s+SYSTEM/i);
    for (const fn of b.split(/CREATE (?:OR REPLACE )?FUNCTION /).slice(1)) { const head = fn.slice(0, fn.indexOf(" AS ")); if (/SECURITY DEFINER/.test(head)) expect(head, fn.slice(0, 40)).toMatch(/SET search_path/); }
  });
  it("the rollback restores the 0055 bodies of the three replaced functions verbatim", () => {
    const m55 = read(D + "0055_futures_paper_worker_security_remediation.sql"), rb = read(D + "0057_worker_credential_pin_and_refusal_tally.rollback.sql");
    const blk = (s: string, start: string) => { const i = s.indexOf(start); return s.slice(s.indexOf(" RETURNS ", i), s.indexOf("  END $f$;\n", i)); };
    for (const f of ["fpw_admin_set_identity(", "fpw_id_check(", "fpw_record_refusal("]) {
      const a = blk(m55, `FUNCTION public.${f}`), b = blk(rb, `FUNCTION public.${f}`);
      expect(a.length, f).toBeGreaterThan(200); expect(b, f).toBe(a);
    }
  });
  it("the locked Phase 4G hosted files are byte-identical", () => {
    expect(sha("src/lib/futures-paper-worker-hosted.ts")).toBe("1cbca841f48026a112a20456fe1e0d01862e76efd89e649ce6ef14cd8a09d824");
    expect(sha("src/lib/futures-paper-worker-hosted.server.ts")).toBe("09e14eb9a66203ab15bc01aa9ae1311411f540faa9b95458f2d3fed9e01343d5");
  });
  it("the new modules are pure: no imports, network, environment, database client, logging or interval timers", () => {
    for (const f of NEW) {
      const s = read(f);
      expect(s, f).not.toMatch(/^import /m);
      expect(s, f).not.toMatch(/\bfetch\(|process\.env|import\.meta\.env|supabase|createServerFn|setInterval|console\.|localStorage|WebSocket/);
    }
  });
  it("only the disabled binding imports them; no route, schedule or flag reaches the bounded invocation", () => {
    const app = walk("src").filter((f) => !f.includes(join("src", "test"))).map((f) => relative(process.cwd(), f));
    expect(app.filter((f) => !NEW.includes(f) && /worker-invocation|worker-refusal-audit/.test(read(f)))).toEqual(["src/lib/futures-paper-worker-identity.server.ts"]);
    expect(app.filter((f) => f !== "src/lib/futures-paper-worker-identity.server.ts" && /runBoundedIdentityInvocation/.test(read(f)))).toEqual([]);
    const places = [...walk("src/routes", /./), ...walk("supabase", /./), ...walk("scripts", /\.(ts|sh|sql)$/), ...["wrangler.toml", "wrangler.jsonc", "vercel.json"].filter(existsSync)];
    expect(places.filter((f) => /runBoundedIdentityInvocation|worker-invocation|fpw_credential_pin|fpw_audit_refusal_completeness/.test(read(f)) && /cron\.schedule|create_http_schedule|net\.http_post|createFileRoute|setInterval/.test(read(f))).map((f) => relative(process.cwd(), f))).toEqual([]);
    const srv = read("src/lib/futures-paper-worker-identity.server.ts");
    expect(srv.match(/process\.env\["FUTURES_PAPER_WORKER_HOSTED"\] !== "enabled" \|\| process\.env\["FUTURES_PAPER_WORKER_IDENTITY"\] !== "signed-in"/g)).toHaveLength(2);
    for (const k of ["FUTURES_PAPER_WORKER_HOSTED", "FUTURES_PAPER_WORKER_IDENTITY", "FUTURES_PAPER_WORKER_EMAIL", "FUTURES_PAPER_WORKER_PASSWORD", "FUTURES_PAPER_WORKER_USER_ID"]) expect(process.env[k], k).toBeUndefined();
  });
  it("the S1–S8 session defaults are unchanged (the invocation passes its own limits explicitly)", () => {
    const s = read("src/lib/worker-auth-session.ts");
    expect(s).toMatch(/authTimeoutMs: 3_000, signOutTimeoutMs: 2_000, tokenSafetyMs: 60_000, minTokenLifetimeMs: 120_000,\n  maxClockSkewMs: 30_000, maxRefreshes: 1 as 0 \| 1, rateLimitCooldownMs: Object\.freeze\(\{ min: 60_000, max: 900_000 \}\),/);
    expect(s).toMatch(/SESSION_GUARDS = Object\.freeze\(\{ maxTokenAgeMs: 300_000, maxInFlight: 4 \}\)/);
  });
});
