// Phase 4H.5 — F13 tamper-evident checkpoints, pure verifier (SYNTHETIC rows; no database). The database side and the
// SQL ↔ TypeScript equality are tested in phase4h5-migration-0055.test.ts (PGlite) and the .pg suite.
import { describe, expect, it } from "vitest";
import { canonicalRow, fieldCode, genesisHead, makeRecord, nextHead, sealRecord, verifyAuditTable, type CheckpointRecord, type DbCheckpoint, type ExportedRow } from "@/lib/audit-checkpoint";

const T = "futures_paper_worker_audit" as const;
const row = (id: number, code = "ID:COMMIT"): ExportedRow => ({ id: String(id), account_id: "00000000-0000-4000-8000-000000000001", user_id: "00000000-0000-4000-8000-000000000002", code, actor: "worker:x", holder: null, fence: String(id), created_at_us: String(1_800_000_000_000_000 + id) });
/** What the 0055 function would return for rows (afterId, toId] continuing from prevHead. */
async function dbcp(rows: ExportedRow[], afterId: number, toId: number, prev: string | null, triggers: Record<string, string> = { futures_paper_worker_audit_immutable: "O" }): Promise<DbCheckpoint> {
  let h = prev ?? (await genesisHead(T)), n = 0;
  for (const r of rows.filter((x) => Number(x["id"]) > afterId && Number(x["id"]) <= toId)) { h = await nextHead(h, canonicalRow(T, r)); n++; }
  return { v: 1, table: T, after_id: afterId, to_id: toId, count: n, head: h, triggers, taken_at_us: "1" };
}
async function store(rows: ExportedRow[], bounds: number[]) {
  const out: CheckpointRecord[] = []; let prev: CheckpointRecord | null = null, after = 0;
  for (const b of bounds) { const r: CheckpointRecord = await makeRecord(await dbcp(rows, after, b, prev?.head ?? null), prev); out.push(r); prev = r; after = b; }
  return out;
}
const ROWS = [1, 2, 3, 5, 6, 7, 8, 9].map((i) => row(i)); // id 4 never committed (a rolled-back insert)
const codes = async (rows: ExportedRow[], recs: CheckpointRecord[], key?: Uint8Array) => (await verifyAuditTable(T, rows, recs, key ? { sealKey: key } : {})).findings.map((f) => f.code);

describe("encoding", () => {
  it("NULL and the empty string differ; text is hex of UTF-8; a missing column is an error, not a silent value", () => {
    expect(fieldCode(null)).toBe("~"); expect(fieldCode("")).toBe(""); expect(fieldCode("é|")).toBe("c3a97c");
    expect(() => canonicalRow(T, { id: "1" })).toThrow(/column account_id missing/);
  });
});
describe("verification against stored checkpoints", () => {
  it("untouched rows verify; rows after the last checkpoint are reported as uncovered, never as verified", async () => {
    const recs = await store(ROWS, [5, 9]);
    const v = await verifyAuditTable(T, [...ROWS, row(10)], recs);
    expect([v.ok, v.verifiedThroughId, v.uncheckpointedRows]).toEqual([true, 9, 1]);
  });
  it("deleting the newest covered row, a middle row or the first row is detected", async () => {
    const recs = await store(ROWS, [5, 9]);
    expect(await codes(ROWS.filter((r) => r["id"] !== "9"), recs)).toEqual(["ROW_MISSING"]);
    expect(await codes(ROWS.filter((r) => r["id"] !== "6"), recs)).toEqual(["ROW_MISSING"]);
    expect(await codes(ROWS.filter((r) => r["id"] !== "1"), recs)).toEqual(["ROW_MISSING"]);
  });
  it("an inserted row (in a gap), a modified column, swapped contents and a reordered or duplicated export are detected", async () => {
    const recs = await store(ROWS, [5, 9]);
    expect(await codes([...ROWS, row(4)].sort((x, y) => Number(x["id"]) - Number(y["id"])), recs)).toEqual(["ROW_ADDED"]);
    expect(await codes(ROWS.map((r) => (r["id"] === "7" ? { ...r, actor: "owner" } : r)), recs)).toEqual(["ROW_CHANGED"]);
    expect(await codes(ROWS.map((r) => (r["id"] === "7" ? { ...r, created_at_us: String(Number(r["created_at_us"]) + 1) } : r)), recs)).toEqual(["ROW_CHANGED"]);
    const a = ROWS[5]!, b = ROWS[6]!;
    expect(await codes(ROWS.map((r) => (r === a ? { ...b, id: a["id"]! } : r === b ? { ...a, id: b["id"]! } : r)), recs)).toEqual(["ROW_CHANGED"]);
    expect(await codes([ROWS[1]!, ROWS[0]!, ...ROWS.slice(2)], recs)).toEqual(["ROWS_OUT_OF_ORDER"]);
    expect(await codes([...ROWS, ROWS[3]!].sort((x, y) => Number(x["id"]) - Number(y["id"])), recs)).toEqual(["DUPLICATE_ID", "ROW_ADDED"]);
    expect(await codes([...ROWS, { ...row(20), id: "x" }], recs)).toEqual(["BAD_ID"]);
  });
  it("stored records that are altered, removed, reordered or not continuing are detected; a disabled trigger at checkpoint time is reported", async () => {
    const recs = await store(ROWS, [3, 6, 9]);
    expect(await codes(ROWS, [recs[0]!, { ...recs[1]!, count: 99 }, recs[2]!])).toEqual(expect.arrayContaining(["CHECKPOINT_RECORD_ALTERED"]));
    expect(await codes(ROWS, [recs[0]!, recs[2]!])).toEqual(expect.arrayContaining(["CHECKPOINT_CHAIN_BROKEN"]));
    expect(await codes(ROWS, [recs[1]!, recs[0]!, recs[2]!])).toEqual(expect.arrayContaining(["CHECKPOINT_CHAIN_BROKEN"]));
    await expect(makeRecord(await dbcp(ROWS, 4, 9, recs[0]!.head), recs[0]!)).rejects.toThrow(/does not continue/);
    await expect(makeRecord(await dbcp(ROWS, 3, 9, recs[0]!.head), null)).rejects.toThrow(/must start at id 0/);
    const d = await makeRecord(await dbcp(ROWS, 0, 9, null, { futures_paper_worker_audit_immutable: "D" }), null);
    expect(await codes(ROWS, [d])).toEqual(["TRIGGER_DISABLED_AT_CHECKPOINT"]);
  });
  it("a whole store rewritten consistently with tampered rows passes without a seal key (residual) and fails with one", async () => {
    const key = new Uint8Array(32).fill(7), tampered = ROWS.filter((r) => r["id"] !== "9");
    const honest = await Promise.all((await store(ROWS, [5, 9])).map((r) => sealRecord(r, key)));
    expect(await codes(ROWS, honest, key)).toEqual([]);
    const forged = await store(tampered, [5, 9]); // an attacker who controls the database AND the store, but not the key
    expect(await codes(tampered, forged)).toEqual([]);
    expect(await codes(tampered, forged, key)).toEqual(["CHECKPOINT_SEAL_MISSING", "CHECKPOINT_SEAL_MISSING"]);
    const resealed = await Promise.all(forged.map((r) => sealRecord(r, new Uint8Array(32).fill(9))));
    expect(await codes(tampered, resealed, key)).toEqual(["CHECKPOINT_SEAL_INVALID", "CHECKPOINT_SEAL_INVALID"]);
    await expect(sealRecord(honest[0]!, new Uint8Array(16))).rejects.toThrow(/at least 32 bytes/);
  });
});
