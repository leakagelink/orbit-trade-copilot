import { describe, expect, it } from "vitest";
import { executeFencedTool, autopilotRequestId, CANCELLED_RESULT } from "@/lib/autopilot-fence";
import { nextTool } from "@/lib/autopilot-run";

// In-memory model of the runner's compare-and-set semantics: a write applies only while the run is active
// AND still held by the writing worker (same filters as `cas` in autopilot-runner.server.ts).
class Runs {
  status = "executing"; holder: string | null = null; enabled = true; halted = false; result: string | null = null; started = false;
  claimLease(h: string) { if (!["waiting_model", "executing"].includes(this.status)) return false; this.holder = h; return true; }
  cas(h: string, patch: () => void) { if (!["waiting_model", "executing"].includes(this.status) || this.holder !== h) return false; patch(); return true; }
  stopActive() { if (["waiting_model", "executing"].includes(this.status)) this.status = "stopped"; this.enabled = false; }
  authorize(h: string) { if (this.status !== "executing" || this.holder !== h) return "This run is no longer active for this worker"; if (!this.enabled) return "Automatic Autopilot was switched off"; if (this.halted) return "Emergency stop is active"; return null; }
}
function worker(runs: Runs, h: string, broker: { submits: number }, hook: { beforeGuard?: () => void; afterSubmit?: () => void } = {}) {
  return executeFencedTool<{ ok: boolean; error?: string }>({
    claim: async () => runs.cas(h, () => { runs.started = true; }),
    authorize: async () => runs.authorize(h),
    cancel: async (reason) => { runs.cas(h, () => { runs.result = CANCELLED_RESULT(reason); runs.status = "stopped"; }); },
    execute: async (guard) => {
      hook.beforeGuard?.();
      try { await guard(); } catch (e) { return { ok: false, error: String(e) }; } // tools wrap errors via safe()
      broker.submits += 1; hook.afterSubmit?.();
      return { ok: true };
    },
    record: async (r) => runs.cas(h, () => { runs.result = JSON.stringify(r); }),
  });
}

describe("Autopilot OFF during an in-flight run", () => {
  it("OFF before the tool starts: nothing executes and the run stops", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A"); runs.enabled = false;
    expect((await worker(runs, "A", broker)).outcome).toBe("cancelled");
    expect(broker.submits).toBe(0); expect(runs.status).toBe("stopped"); expect(runs.result).toMatch(/Nothing was submitted/);
  });
  it("OFF after the tool started but before submission: the pre-submit guard blocks the order", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A");
    await worker(runs, "A", broker, { beforeGuard: () => runs.stopActive() });
    expect(broker.submits).toBe(0); expect(runs.status).toBe("stopped");
  });
  it("emergency stop before submission blocks the order", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A");
    await worker(runs, "A", broker, { beforeGuard: () => { runs.halted = true; } });
    expect(broker.submits).toBe(0);
  });
  it("OFF after submission: the result is orphaned for reconciliation and the run is not resurrected", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A");
    const r = await worker(runs, "A", broker, { afterSubmit: () => runs.stopActive() });
    expect(r.outcome).toBe("orphaned"); expect(broker.submits).toBe(1); expect(runs.status).toBe("stopped"); expect(runs.result).toBeNull();
  });
});

describe("stale worker updates and duplicate execution", () => {
  it("a worker whose lease was taken over cannot start the tool", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A"); runs.claimLease("B"); // A's lease expired, B claimed
    expect((await worker(runs, "A", broker)).outcome).toBe("lost"); expect(broker.submits).toBe(0); expect(runs.started).toBe(false);
  });
  it("a stale worker cannot overwrite the newer holder's result", async () => {
    const runs = new Runs(), broker = { submits: 0 }; runs.claimLease("A");
    const r = await worker(runs, "A", broker, { afterSubmit: () => runs.claimLease("B") });
    expect(r.outcome).toBe("orphaned"); expect(runs.result).toBeNull(); expect(runs.holder).toBe("B");
  });
  it("a stopped run rejects every later worker write", () => {
    const runs = new Runs(); runs.claimLease("A"); runs.stopActive();
    expect(runs.cas("A", () => { runs.status = "waiting_model"; })).toBe(false); expect(runs.status).toBe("stopped");
    expect(runs.claimLease("C")).toBe(false);
  });
  it("a tool that started without a result is reported as interrupted, never re-run", () =>
    expect(nextTool([{ id: "t1", name: "live_open_futures_scalp", input: {}, started: true }]).kind).toBe("interrupted"));
  it("request IDs are deterministic per run + tool call, so a duplicate hits the same idempotency claim", async () => {
    const a = await autopilotRequestId("run-1", "toolu_1"), b = await autopilotRequestId("run-1", "toolu_1"), c = await autopilotRequestId("run-1", "toolu_2");
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
