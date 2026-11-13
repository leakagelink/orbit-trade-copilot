// Phase 4G — pure tests of the hosted connection's error classification, redaction, allowlist and deadlines. No
// database, no network: `rpc` is a local function.
import { describe, expect, it } from "vitest";
import { HOSTED_WORKER_RPCS, classifyRpc, createHostedWorkerPorts, redactSecrets } from "@/lib/futures-paper-worker-hosted";

const reply = (code: string | null, message = "x", status = 400) => ({ reply: { data: null, error: { code, message }, status } });
describe("classifyRpc: what each failure proves", () => {
  it.each([
    ["timeout", { timedOut: true }, "no_response"],
    ["network error (thrown)", { thrown: new TypeError("fetch failed") }, "no_response"],
    ["status 0 (fetch failed inside the client)", reply("", "TypeError: fetch failed", 0), "no_response"],
    ["gateway timeout 504", reply(null, "timeout", 504), "no_response"],
    ["service unavailable 503", reply("PGRST003", "pool timeout", 503), "no_response"],
    ["connection failure 08006", reply("08006", "connection failure"), "no_response"],
    ["serialization failure", reply("40001", "could not serialize"), "transient"],
    ["deadlock", reply("40P01", "deadlock detected"), "transient"],
    ["statement timeout (cancelled, rolled back)", reply("57014", "canceling statement due to statement timeout"), "transient"],
    ["backend terminated (rolled back)", reply("57P01", "terminating connection due to administrator command"), "transient"],
    ["function missing (migration not applied)", reply("PGRST202", "Could not find the function"), "transient"],
    ["permission denied", reply("42501", "permission denied for function"), "transient"],
    ["lease lost", reply("P0001", "futures paper worker lease lost"), "transient"],
    ["entry too late", reply("P0001", "futures paper worker: candle 1 closed 9 ms ago; new entries need data younger than 5 ms"), "transient"],
    ["0049 refusal", reply("P0001", "approval refused: risk 11 exceeds the per-trade maximum 10"), "refused"],
    ["0049 JSON typing", reply("22023", "futures paper: qty must be a JSON number"), "refused"],
    ["unique violation", reply("23505", "duplicate key"), "refused"],
    ["ok", { reply: { data: 3, error: null, status: 200 } }, "ok"],
  ])("%s → %s", (_why, input, kind) => { expect(classifyRpc(input as never).kind).toBe(kind); });
  it("never treats a reply-less failure as 'nothing happened' (a commit may have landed)", () => {
    for (const x of [{ timedOut: true }, { thrown: 1 }, reply(null, "", 0), reply(null, "", 502)]) expect(classifyRpc(x as never).kind).toBe("no_response");
  });
  it("drops error codes that are not SQLSTATE/PostgREST shaped (nothing free-form reaches monitoring)", () => {
    expect((classifyRpc(reply("evil code with spaces", "boom")) as { pgCode: string | null }).pgCode).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("removes JWTs, API keys, bearer tokens, key=value secrets and URL credentials; keeps the refusal wording", () => {
    const s = redactSecrets("approval refused: risk 11 exceeds 10 apikey=sb_secret_abcdef Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlMTIz password=hunter2 postgres://u:p@h/db sb_publishable_xyz");
    expect(s).toContain("approval refused: risk 11 exceeds 10");
    for (const x of ["sb_secret_abcdef", "eyJhbGci", "hunter2", "u:p@", "sb_publishable_xyz"]) expect(s).not.toContain(x);
    expect(redactSecrets("x".repeat(2000)).length).toBe(500);
  });
});

describe("allowlist and deadlines", () => {
  it("only the six gateway functions exist in the allowlist (no table access, no other function)", () => {
    expect([...HOSTED_WORKER_RPCS]).toEqual(["fpw_acquire_lease", "fpw_release_lease", "fpw_snapshot", "fpw_evaluated", "fpw_commit", "fpw_mark_review"]);
  });
  it("a call that never answers is abandoned at the deadline and its request is aborted", async () => {
    let aborted = false;
    const p = createHostedWorkerPorts({ holder: "00000000-0000-4000-8000-000000000001", clock: { now: () => 0 }, timeoutMs: 20,
      rpc: (_fn, _a, signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }) });
    const t = Date.now();
    expect(await p.db.tryAcquireLease("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(aborted).toBe(true); expect(Date.now() - t).toBeLessThan(2_000);
  });
  it("a different holder than the configured one is refused without a call", async () => {
    let calls = 0;
    const p = createHostedWorkerPorts({ holder: "00000000-0000-4000-8000-000000000001", clock: { now: () => 0 }, rpc: async () => { calls++; return { data: 1, error: null }; } });
    expect(await p.db.tryAcquireLease("a", "someone-else")).toBe(false); expect(calls).toBe(0);
  });
});
