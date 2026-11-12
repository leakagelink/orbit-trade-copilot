// The local-only restore verifier for draft 0046 refuses anything that is not an explicit local backup file and never
// uses ambient credentials. (End-to-end restore on synthetic backups: scripts/db-export/test-verify-local-restore-0046.sh.)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/db-export/verify-local-restore-0046.sh";
const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 20_000 });

describe("local-only restore verifier — input refusals", () => {
  it.each([
    ["a postgres URL", "postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"],
    ["a pooler connection string", "host=aws-0-eu.pooler.supabase.com dbname=postgres user=postgres"],
    ["an https download", "https://example.supabase.co/storage/v1/object/exports/x.backup"],
    ["a storage bucket path", "exports/orbit-trade-copilot.backup"],
    ["a missing file", "/tmp/definitely-not-here-0046.backup"],
  ])("refuses %s with exit code 2 before starting any database", (_n, arg) => {
    const r = run([arg]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
  });
  it("refuses a second (target) argument", () => {
    const r = run(["/etc/hostname", "postgres://prod"]);
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/exactly one argument/);
  });
  it("refuses a directory", () => { expect(run(["/tmp"]).status).toBe(2); });
});

describe("local-only restore verifier — source guarantees", () => {
  const src = readFileSync(SCRIPT, "utf8");
  it("unsets every ambient connection variable and talks only to its private UNIX socket", () => {
    for (const v of ["DATABASE_URL", "PGHOST", "PGPASSWORD", "PGSERVICE", "LOVABLE_DB_MIGRATION_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) expect(src).toContain(v);
    expect(src).toMatch(/listen_addresses=''/);
    expect(src).not.toMatch(/curl|wget|storage\/v1/);
    // every psql / pg_restore that touches a database goes through local_pg (or the one bootstrap call on the socket)
    const direct = src.split("\n").filter((l) => /\b(psql|pg_restore)\b/.test(l) && !/local_pg|^#|refuse|pg_restore --list|pg_restore:? error|PGHOST="\$SOCK"|tool/.test(l.trim()));
    expect(direct).toEqual([]);
  });
  it("applies the draft and its rollback each in a single transaction and never applies anything else", () => {
    expect(src.match(/--single-transaction -f "\$(MIG|RB)"/g)).toHaveLength(2);
    expect(src).not.toMatch(/0044_|0043_|0042_|0045_.*\.sql"\s*>/);
  });
});
