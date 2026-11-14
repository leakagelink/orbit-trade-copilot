// Tamper-evident audit checkpoints for the Futures PAPER worker audit tables (Phase 4H.5, F13; DRAFT 0055 — not
// applied). Pure and browser-safe (Web Crypto only): no network, database, environment or storage access. Nothing in
// the app imports it; there is no route, schedule or background job.
//
// Model. A checkpoint is taken by an MFA-verified admin with the 0055 database function fpw_audit_checkpoint and then
// stored OUTSIDE the database (for example a file the owner keeps, a commit in a separate repository, a printed copy).
// It records, per audit table, the covered id range, the row count and a rolling SHA-256 head over every covered row.
// Later, rows exported from the database (or from a restored backup) are re-hashed HERE, independently of any database
// function, and compared with every stored checkpoint. Checkpoint records are chained to each other and may be sealed
// with an HMAC key the database never sees.
// Detects (for rows covered by a stored checkpoint): a deleted row (newest included), an inserted row, any modified
// column, rows moved to other ids, a rewritten 0052 hash chain, a disabled audit trigger at checkpoint time, and a
// removed, altered, reordered or forged checkpoint record (forgery needs the seal key when seals are used).
// Does NOT detect: changes to rows written after the latest stored checkpoint, or tampering that also replaces every
// stored checkpoint copy (and the seal key). It is detection after the fact, never prevention.

export const AUDIT_TABLES = {
  futures_paper_worker_audit: ["id", "account_id", "user_id", "code", "actor", "holder", "fence", "created_at_us"],
  futures_paper_config_changes: ["id", "user_id", "entity", "entity_key", "operation", "old_value", "new_value", "actor_role", "actor_uid", "actor_label", "reason", "version", "value_sha256", "prev_sha256", "chain_sha256", "changed_at_us"],
  futures_paper_worker_identity_changes: ["id", "worker_user_id", "old_enabled", "new_enabled", "old_label", "new_label", "actor", "created_at_us"],
  futures_paper_worker_refusals: ["id", "worker_user_id", "account_id", "fn", "sqlstate", "reason", "session_id", "created_at_us"],
} as const;
export type AuditTable = keyof typeof AUDIT_TABLES;
/** One exported row: every column as PostgreSQL text output (`::text`), NULL as null; timestamps as integer microseconds. */
export type ExportedRow = Record<string, string | null>;

/** SELECT for a READ-ONLY export from the database or a restored copy (uses no 0055 function, so a replaced function cannot hide anything). */
export function exportQuery(table: AuditTable): string {
  const col = (c: string) => (c.endsWith("_at_us") ? `floor(extract(epoch FROM t.${c.slice(0, -3)}) * 1000000)::bigint::text AS ${c}` : `t.${c}::text AS ${c}`);
  return `SELECT ${AUDIT_TABLES[table].map(col).join(", ")} FROM public.${table} t ORDER BY t.id`; // numeric order (not the text alias)
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(s: string): Promise<string> { return hex(await globalThis.crypto.subtle.digest("SHA-256", enc.encode(s))); }
/** Same encoding as 0055 fpw_cp_field: hex of the UTF-8 text, '~' for NULL. */
export const fieldCode = (v: string | null) => (v === null ? "~" : hex(enc.encode(v)));
export function canonicalRow(table: AuditTable, row: ExportedRow): string {
  return AUDIT_TABLES[table].map((c) => {
    const v = row[c];
    if (v === undefined) throw new Error(`audit checkpoint: column ${c} missing in exported ${table} row`);
    return fieldCode(v);
  }).join("|");
}
export const genesisHead = (table: AuditTable) => sha256Hex(`fpw-audit-v1|${table}`);
export async function nextHead(prev: string, canon: string) { return sha256Hex(`${prev}|${canon}`); }

/** What fpw_audit_checkpoint returns (0055). */
export interface DbCheckpoint { v: 1; table: AuditTable; after_id: number; to_id: number; count: number; head: string; triggers: Record<string, string>; taken_at_us: string }
/** The record stored outside the database. `prev` links to the previous record of the same table (null for the first). */
export interface CheckpointRecord { v: 1; table: AuditTable; afterId: number; toId: number; count: number; head: string; triggers: Record<string, string>; takenAtUs: string; prev: string | null; sha: string; seal?: string }

const canonJson = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().reduce<Record<string, unknown>>((a, k) => { const v = o[k]; a[k] = v && typeof v === "object" && !Array.isArray(v) ? JSON.parse(canonJson(v as Record<string, unknown>)) : v; return a; }, {}));
async function recordSha(r: Omit<CheckpointRecord, "sha" | "seal">) { return sha256Hex(canonJson({ ...r } as Record<string, unknown>)); }

/** Turns a database checkpoint into the external record, linked to the previous stored record of that table. */
export async function makeRecord(db: DbCheckpoint, prev: CheckpointRecord | null): Promise<CheckpointRecord> {
  if (!(db.table in AUDIT_TABLES) || db.v !== 1) throw new Error("audit checkpoint: unknown table or version");
  if (prev && (prev.table !== db.table || prev.toId !== db.after_id)) throw new Error("audit checkpoint: does not continue the previous stored record");
  if (!prev && db.after_id !== 0) throw new Error("audit checkpoint: the first stored record must start at id 0");
  const base = { v: 1 as const, table: db.table, afterId: db.after_id, toId: db.to_id, count: db.count, head: db.head, triggers: { ...db.triggers }, takenAtUs: String(db.taken_at_us), prev: prev ? prev.sha : null };
  return { ...base, sha: await recordSha(base) };
}
async function hmacKey(key: Uint8Array) { return globalThis.crypto.subtle.importKey("raw", Uint8Array.from(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
/** Optional seal with a key kept outside the database and outside the worker runtime. */
export async function sealRecord(r: CheckpointRecord, key: Uint8Array): Promise<CheckpointRecord> {
  if (key.length < 32) throw new Error("audit checkpoint: seal key must be at least 32 bytes");
  return { ...r, seal: hex(await globalThis.crypto.subtle.sign("HMAC", await hmacKey(key), enc.encode(r.sha))) };
}

export type Finding =
  | { code: "CHECKPOINT_CHAIN_BROKEN" | "CHECKPOINT_RECORD_ALTERED" | "CHECKPOINT_SEAL_INVALID" | "CHECKPOINT_SEAL_MISSING"; index: number }
  | { code: "TRIGGER_DISABLED_AT_CHECKPOINT"; index: number; trigger: string; state: string }
  | { code: "ROWS_OUT_OF_ORDER" | "DUPLICATE_ID" | "BAD_ID"; id: string }
  | { code: "ROW_MISSING" | "ROW_ADDED" | "ROW_CHANGED"; index: number; afterId: number; toId: number; expectedCount: number; actualCount: number };
export interface VerifyResult { table: AuditTable; ok: boolean; findings: Finding[]; verifiedThroughId: number; uncheckpointedRows: number; checkpoints: number }

/**
 * Re-hashes the exported rows from genesis and checks every stored checkpoint. `rows` must be the full export of the
 * table (any order; it is checked). With `sealKey`, every record must carry a valid seal.
 */
export async function verifyAuditTable(table: AuditTable, rows: ExportedRow[], records: CheckpointRecord[], o: { sealKey?: Uint8Array } = {}): Promise<VerifyResult> {
  const findings: Finding[] = [];
  // 1. the stored records themselves
  let prev: CheckpointRecord | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const { sha, seal, ...base } = r;
    if (r.table !== table || (await recordSha(base)) !== sha) findings.push({ code: "CHECKPOINT_RECORD_ALTERED", index: i });
    if ((prev === null ? r.prev !== null || r.afterId !== 0 : r.prev !== prev.sha || r.afterId !== prev.toId) || r.toId < r.afterId) findings.push({ code: "CHECKPOINT_CHAIN_BROKEN", index: i });
    if (o.sealKey) {
      if (!seal) findings.push({ code: "CHECKPOINT_SEAL_MISSING", index: i });
      else {
        const bytes = new Uint8Array((seal.match(/../g) ?? []).map((h) => parseInt(h, 16)));
        if (!/^[0-9a-f]{64}$/.test(seal) || !(await globalThis.crypto.subtle.verify("HMAC", await hmacKey(o.sealKey), bytes, enc.encode(sha)))) findings.push({ code: "CHECKPOINT_SEAL_INVALID", index: i });
      }
    }
    for (const [tg, st] of Object.entries(r.triggers ?? {})) if (st !== "O") findings.push({ code: "TRIGGER_DISABLED_AT_CHECKPOINT", index: i, trigger: tg, state: st });
    prev = r;
  }
  // 2. the exported rows: integer ids, strictly increasing once sorted, no duplicates
  const parsed: { id: bigint; row: ExportedRow }[] = [];
  for (const row of rows) {
    const s = row["id"];
    if (typeof s !== "string" || !/^[1-9][0-9]{0,18}$/.test(s)) { findings.push({ code: "BAD_ID", id: String(s) }); continue; }
    parsed.push({ id: BigInt(s), row });
  }
  for (let i = 1; i < parsed.length; i++) if (parsed[i]!.id < parsed[i - 1]!.id) { findings.push({ code: "ROWS_OUT_OF_ORDER", id: String(parsed[i]!.id) }); break; }
  parsed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < parsed.length; i++) if (parsed[i]!.id === parsed[i - 1]!.id) findings.push({ code: "DUPLICATE_ID", id: String(parsed[i]!.id) });
  // 3. re-hash from genesis and compare at every checkpoint boundary
  let head = await genesisHead(table), k = 0, verifiedThroughId = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!; let n = 0;
    while (k < parsed.length && parsed[k]!.id <= BigInt(r.toId)) { if (parsed[k]!.id > BigInt(r.afterId)) { head = await nextHead(head, canonicalRow(table, parsed[k]!.row)); n++; } k++; }
    if (n !== r.count || head !== r.head) {
      findings.push({ code: n < r.count ? "ROW_MISSING" : n > r.count ? "ROW_ADDED" : "ROW_CHANGED", index: i, afterId: r.afterId, toId: r.toId, expectedCount: r.count, actualCount: n });
      head = r.head; // continue from the stored head so later ranges are judged on their own rows
    } else verifiedThroughId = r.toId;
  }
  const uncheckpointedRows = parsed.length - k;
  return { table, ok: findings.length === 0, findings, verifiedThroughId: findings.length === 0 ? verifiedThroughId : Math.min(verifiedThroughId, firstBad(findings, records)), uncheckpointedRows, checkpoints: records.length };
}
function firstBad(f: Finding[], records: CheckpointRecord[]) {
  const idx = f.filter((x): x is Extract<Finding, { index: number }> => "index" in x).map((x) => x.index);
  if (!idx.length) return 0;
  const i = Math.min(...idx); return i === 0 ? 0 : records[i - 1]!.toId;
}
