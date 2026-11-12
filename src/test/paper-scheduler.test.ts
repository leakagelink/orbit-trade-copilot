// Phase 3 scheduler readiness: one paper tick is bounded in time and commits, and strategies it could not reach run
// first next time. Pure, in-memory store; no network or database.
import { describe, expect, it } from "vitest";
import { runPaperTick, PAPER_TICK_BUDGET_MS, type PaperStore, type PaperStrategyRow } from "@/lib/paper.server";

const rows = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `s${k}`, user_id: "u", tf_ms: 3_600_000, cursor_t: 0, status: "active" }) as unknown as PaperStrategyRow);
const fakeStore = (list: PaperStrategyRow[], marks: string[]): PaperStore => ({
  async listRunnable() { return list; }, async account() { throw new Error("unused"); }, async hasPro() { return true; },
  async commit() { throw new Error("unused"); }, async mark(id) { marks.push(id); },
});

describe("paper tick budget", () => {
  it("stops starting new strategies once the time budget is used and defers the rest untouched", async () => {
    let t = 0; const clock = () => (t += PAPER_TICK_BUDGET_MS / 2 + 1, t); // each check advances the clock by > half the budget
    const marks: string[] = [];
    const out = await runPaperTick(fakeStore(rows(4), marks), async () => { throw new Error("feed down"); }, Date.now(), clock);
    expect(out.map((r) => r.outcome)).toEqual(["data_outage", "deferred", "deferred", "deferred"]);
    expect(marks).toEqual(["s0"]); // deferred strategies keep their old check time, so they sort first next tick
  });
  it("a market-data outage changes nothing but the status line", async () => {
    const marks: string[] = [];
    const out = await runPaperTick(fakeStore(rows(2), marks), async () => { throw new Error("503"); });
    expect(out.every((r) => r.outcome === "data_outage" && r.committed === 0)).toBe(true);
  });
});

describe("paused-strategy notices", () => {
  it("a data gap pauses the strategy once and sends one deduplicated owner notice; nothing is filled", async () => {
    const notices: string[] = [], marks: { status?: string }[] = [];
    const s = { id: "s1", user_id: "u1", tf_ms: 60_000, cursor_t: 0, status: "active" } as unknown as PaperStrategyRow;
    const store: PaperStore = { ...fakeStore([s], []), async mark(_id, f) { marks.push(f); }, async notifyPaused(u, _sid, key) { notices.push(`${u}|${key}`); } };
    const candles = [{ t: 180_000, o: 1, h: 1, l: 1, c: 1, v: 1 }]; // candle 60_000 is missing
    const r = await runPaperTick(store, async () => ({ candles, fetchedAt: 0 }), 10_000_000);
    expect(r[0]!.outcome).toBe("data_gap");
    expect(marks[0]!.status).toBe("paused");
    expect(notices).toEqual(["u1|paper-paused:s1:gap:60000"]);
    // Already paused: no second notice on the next tick.
    const again = await runPaperTick({ ...store, async listRunnable() { return [{ ...s, status: "paused" } as PaperStrategyRow]; } }, async () => ({ candles, fetchedAt: 0 }), 10_000_000);
    expect(again[0]!.outcome).toBe("data_gap");
    expect(notices).toHaveLength(1);
  });
  it("a failing notice never blocks processing", async () => {
    const s = { id: "s1", user_id: "u1", tf_ms: 60_000, cursor_t: 0, status: "active" } as unknown as PaperStrategyRow;
    const store: PaperStore = { ...fakeStore([s], []), async notifyPaused() { throw new Error("inbox down"); } };
    const r = await runPaperTick(store, async () => ({ candles: [{ t: 180_000, o: 1, h: 1, l: 1, c: 1, v: 1 }], fetchedAt: 0 }), 10_000_000);
    expect(r[0]!.outcome).toBe("data_gap");
  });
});
