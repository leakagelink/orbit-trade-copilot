import { describe, expect, it } from "vitest";
import { make0055Db, RB_0055, MIG_0056, RB_0056, MIG_0055 } from "./helpers/fp-0055-harness";
describe("smoke", () => {
  it("applies 0055, 0056 and rolls back both, then re-applies", async () => {
    const db = await make0055Db({ with0056: true });
    await db.exec(RB_0056); await db.exec(RB_0055);
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_policy WHERE polname='fpw_worker_identity_guard'`);
    expect(r.rows[0]!.n).toBe(0);
    await expect(db.exec(MIG_0055)).rejects.toThrow(/earlier 0055/);
  }, 120_000);
});
