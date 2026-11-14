// Offline tool for the Phase 4H.5 audit checkpoints (src/lib/audit-checkpoint.ts; DRAFT 0055 — not applied).
// It never connects to any database or network: it reads local files only.
//
//   bun scripts/audit-checkpoint/audit-checkpoints.ts append <store.jsonl> <db-checkpoint.json> [seal-key-file]
//       Appends the reply of fpw_audit_checkpoint (saved to a file by an MFA-verified admin) to the external store,
//       chained to that table's previous record and optionally sealed. Keep the store OUTSIDE the database.
//   bun scripts/audit-checkpoint/audit-checkpoints.ts verify <store.jsonl> <table>=<rows.json> ... [--seal-key <file>]
//       Re-hashes rows exported with exportQuery(table) (JSON array of objects) and checks every stored record.
//       Exit code 0 = no finding, 1 = findings, 2 = usage error.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { AUDIT_TABLES, makeRecord, sealRecord, verifyAuditTable, type AuditTable, type CheckpointRecord, type DbCheckpoint, type ExportedRow } from "../../src/lib/audit-checkpoint";

const readStore = (f: string): CheckpointRecord[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CheckpointRecord) : []);
const key = (f: string | undefined) => (f ? new Uint8Array(readFileSync(f)) : undefined);
async function main(argv: string[]) {
  const [cmd, store, ...rest] = argv;
  if (cmd === "append" && store && rest[0]) {
    const db = JSON.parse(readFileSync(rest[0], "utf8")) as DbCheckpoint;
    const prev = readStore(store).filter((r) => r.table === db.table).at(-1) ?? null;
    let rec = await makeRecord(db, prev);
    const k = key(rest[1]); if (k) rec = await sealRecord(rec, k);
    appendFileSync(store, JSON.stringify(rec) + "\n");
    console.log(JSON.stringify({ appended: rec.table, toId: rec.toId, count: rec.count, sha: rec.sha, sealed: Boolean(rec.seal) }));
    return 0;
  }
  if (cmd === "verify" && store) {
    const i = rest.indexOf("--seal-key"), sealKey = i >= 0 ? key(rest[i + 1]) : undefined;
    const pairs = rest.filter((a, j) => a.includes("=") && (i < 0 || (j !== i && j !== i + 1)));
    if (!pairs.length) return 2;
    const all = readStore(store); let bad = false;
    for (const p of pairs) {
      const [t, f] = p.split("=") as [string, string];
      if (!(t in AUDIT_TABLES)) return 2;
      const rows = JSON.parse(readFileSync(f, "utf8")) as ExportedRow[];
      const r = await verifyAuditTable(t as AuditTable, rows, all.filter((x) => x.table === t), sealKey ? { sealKey } : {});
      bad ||= !r.ok;
      console.log(JSON.stringify(r));
    }
    return bad ? 1 : 0;
  }
  console.error("usage: append <store.jsonl> <db-checkpoint.json> [seal-key-file] | verify <store.jsonl> <table>=<rows.json> ... [--seal-key <file>]");
  return 2;
}
main(process.argv.slice(2)).then((c) => process.exit(c), () => process.exit(2));
