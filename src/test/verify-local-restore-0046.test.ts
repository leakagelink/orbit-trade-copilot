// The local-only restore verifiers (draft 0046, and since Phase 4E draft 0048) refuse anything that is not an explicit
// local backup file and never use ambient credentials. End-to-end restore on synthetic backups:
// scripts/db-export/test-verify-local-restore-0046.sh; on the real 13 Nov 2026 export: docs/phase-4e/phase4e-final-report.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe.each([
  ["0046", "scripts/db-export/verify-local-restore-0046.sh"],
  ["0048", "scripts/db-export/verify-local-restore-0048.sh"],
])("local-only restore verifier %s", (draft, SCRIPT) => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 20_000 });
  it.each([
    ["a postgres URL", "postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"],
    ["a pooler connection string", "host=aws-0-eu.pooler.supabase.com dbname=postgres user=postgres"],
    ["an https download", "https://example.supabase.co/storage/v1/object/exports/x.backup"],
    ["a storage bucket path", "exports/orbit-trade-copilot.backup"],
    ["a missing file", `/tmp/definitely-not-here-${draft}.backup`],
  ])("refuses %s with exit code 2 before starting any database", (_n, arg) => {
    const r = run([arg]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
  });
  it("refuses a second (target) argument and a directory", () => {
    const r = run(["/etc/hostname", "postgres://prod"]);
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/exactly one argument/);
    expect(run(["/tmp"]).status).toBe(2);
  });
  const src = readFileSync(SCRIPT, "utf8");
  it("unsets every ambient connection variable and talks only to its private UNIX socket", () => {
    for (const v of ["DATABASE_URL", "PGHOST", "PGPASSWORD", "PGSERVICE", "LOVABLE_DB_MIGRATION_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) expect(src).toContain(v);
    expect(src).toMatch(/listen_addresses=''/);
    expect(src).not.toMatch(/curl|wget|storage\/v1/);
    const direct = src.split("\n").filter((l) => /\b(psql|pg_restore)\b/.test(l) && !/local_pg|^#|refuse|pg_restore --list|pg_restore:? error|PGHOST="\$SOCK"|tool/.test(l.trim()));
    expect(direct).toEqual([]);
    // Archive parsing writes SQL text to stdout and never names a database.
    for (const l of src.split("\n").filter((x) => /pg_restore --(file|list)/.test(x))) expect(l).not.toMatch(/\s-d\s|--dbname/);
  });
  it("tolerates only managed-extension restore errors, creates every role the archive grants to, and FAILs otherwise", () => {
    expect(src).toMatch(/cron\|net\|vault\|pg_cron\|pg_net\|supabase_vault\|pgsodium/);
    expect(src).toContain("ARCHIVE_ROLES");
    expect(src).toMatch(/\[\[ \$FAIL -gt 0 \|\| "\$\{ERR_UNEXPECTED:-1\}" != 0 \]\] && VERDICT=FAIL/);
    expect(src).toContain("Fidelity: public table/view privileges");
    expect(src).toContain("commands not printed");
  });
  it("applies only its own draft (and, for 0048, the 0046 coexistence round trip), each in a single transaction", () => {
    if (draft === "0046") expect(src.match(/--single-transaction -f "\$(MIG|RB)"/g)).toHaveLength(2);
    else { expect(src.match(/--single-transaction -f "\$(MIG|RB)"/g)).toHaveLength(2); expect(src).toMatch(/for f in "\$M46" "\$MIG" "\$RB" "\$R46"/); }
    expect(src).not.toMatch(/0044_|0043_|0042_|0045_.*\.sql"\s*>|0047_futures_strategy_attribution\.sql/);
  });
});
