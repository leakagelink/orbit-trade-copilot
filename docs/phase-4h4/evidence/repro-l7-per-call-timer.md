# L7 reproduction (fakes only, no network) — run 2026-11-14T03:28:31Z

Command: `cd /dev-server && NODE_PATH=/dev-server/node_modules bun /tmp/phase4h4/repro-l7.ts` (script kept outside the project; full text below).

## Output
```json
{"case":"A timer setup throws","adapterOutcome":"rejected (exception, not classified)","waitedMs":52,"requestsStarted":1,"requestSignalAborted":false}
{"case":"B timer never fires","adapterOutcomeAfter1500ms":"pending","requestsStarted":1,"requestSignalAborted":false}
{"case":"C stalled per-call timer inside session","outcome":"TICK_DEADLINE_EXCEEDED","signOut":"SIGNED_OUT","elapsedMs":1306,"signOutRequests":1,"dataRequestsStarted":1,"inFlightRequestAbortedByTickEnd":false}
```

## Script (verbatim)
```ts
// Phase 4H.4 reproduction (investigation only; no project file is changed). Uses fakes only: no network.
import { createHostedWorkerPorts, runHostedFuturesPaperWorkerTick, type HostedRpc } from "/dev-server/src/lib/futures-paper-worker-hosted.ts";
import { runWithWorkerSession } from "/dev-server/src/lib/worker-auth-session.ts";
import { fakeAuth, issued, ok, noContent, WORKER } from "/dev-server/src/test/helpers/fake-auth.ts";
const HOLDER = "00000000-0000-4000-8000-00000000aaaa", ACC = "00000000-0000-4000-8000-0000000000a1";
const clock = { now: () => Date.now() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function hangingRpc() {
  const sent: { fn: string; signal: AbortSignal }[] = [];
  const rpc: HostedRpc = (fn, _a, signal) => { sent.push({ fn, signal }); return new Promise(() => {}); };
  return { rpc, sent };
}
async function caseA() {
  // A: the per-call timer cannot be armed (setTimeout throws inside the Promise executor, line 94).
  const { rpc, sent } = hangingRpc();
  const p = createHostedWorkerPorts({ rpc, holder: HOLDER, clock, timers: { setTimeout: () => { throw new Error("timer unavailable"); }, clearTimeout: () => {} } });
  const t0 = Date.now(); let outcome = "pending";
  await p.db.tryAcquireLease(ACC, HOLDER).then((v) => { outcome = `resolved ${v}`; }, () => { outcome = "rejected (exception, not classified)"; });
  await sleep(50);
  console.log(JSON.stringify({ case: "A timer setup throws", adapterOutcome: outcome, waitedMs: Date.now() - t0, requestsStarted: sent.length, requestSignalAborted: sent[0]?.signal.aborted ?? null }));
}
async function caseB() {
  // B: the timer is armed but never fires (stalled timer source); the reply never arrives.
  const { rpc, sent } = hangingRpc();
  const p = createHostedWorkerPorts({ rpc, holder: HOLDER, clock, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
  let outcome = "pending"; p.db.tryAcquireLease(ACC, HOLDER).then((v) => { outcome = `resolved ${v}`; }, () => { outcome = "rejected"; });
  await sleep(1500);
  console.log(JSON.stringify({ case: "B timer never fires", adapterOutcomeAfter1500ms: outcome, requestsStarted: sent.length, requestSignalAborted: sent[0]?.signal.aborted ?? null }));
}
async function caseC() {
  // C: same stalled per-call timer, but run inside the Phase 4H.3 session (real platform timers for the session).
  const auth = fakeAuth({ signIn: [ok(issued(Date.now()))], signOut: [noContent] });
  const sent: { fn: string; signal: AbortSignal }[] = [];
  const data = (fn: string, _a: Record<string, unknown>, _t: string, signal: AbortSignal) => { sent.push({ fn, signal }); return new Promise<never>(() => {}); };
  const t0 = Date.now();
  const r = await runWithWorkerSession({ auth, data, resolveFn: (f) => `fpw_id_${f.replace(/^fpw_/, "")}`, clock, expectedUserId: WORKER,
    limits: { tickBudgetMs: 1500, rpcTimeoutMs: 400, authTimeoutMs: 200, signOutTimeoutMs: 200, tokenSafetyMs: 1000, minTokenLifetimeMs: 2000 } },
    (call) => runHostedFuturesPaperWorkerTick({ enabled: true, rpc: call as HostedRpc, holder: HOLDER, accounts: [ACC], clock: { ...clock, sleep } as never,
      market: { candles: async () => [] } as never, intents: { forCandle: async () => [] } as never, hosted: { timeoutMs: 400, timers: { setTimeout: () => 1, clearTimeout: () => {} } } } as never));
  console.log(JSON.stringify({ case: "C stalled per-call timer inside session", outcome: r.outcome, signOut: r.signOut, elapsedMs: Date.now() - t0, signOutRequests: auth.log.filter((x) => x === "signOut").length, dataRequestsStarted: sent.length, inFlightRequestAbortedByTickEnd: sent[0]?.signal.aborted ?? null }));
}
await caseA(); await caseB(); await caseC();
process.exit(0);
```
