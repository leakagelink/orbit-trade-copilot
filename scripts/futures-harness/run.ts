// Phase 1.6 Testnet certification harness runner. Usage (sandbox, Testnet only):
//   HARNESS_CONFIRM=TESTNET HARNESS_TEST_USER_ID=… HARNESS_OWNER_USER_ID=… HARNESS_CONNECTION_ID=… bun scripts/futures-harness/run.ts [scenario|all]
// Refuses unless isolation is proven. Writes evidence JSON under docs/certification/. Never writes certification records.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { supabaseAdmin as db } from '@/integrations/supabase/client.server';
import { harnessConfig, prepareHarness, scenario, recoverAfterCrash, SCENARIO_RUNNERS, type HarnessContext } from '@/lib/futures-harness.server';
import { HARNESS_OVERALL_STATUS, SCENARIOS, type ScenarioResult } from '@/lib/futures-harness';
import type { FuturesCheckpoint } from '@/lib/futures.server';

const CHECKPOINTS: FuturesCheckpoint[] = ['after_claim', 'after_submit_started', 'after_entry_submit', 'after_protection_submit'];
function child(cp: FuturesCheckpoint, requestId: string) {
  return new Promise<{ signal: string | null; out: string }>(resolve => {
    const c = spawn('bun', ['scripts/futures-harness/crash-child.ts', cp, requestId], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', d => { out += String(d); });
    c.on('exit', (_code, signal) => resolve({ signal, out }));
  });
}
const crashRestart = (ctx: HarnessContext) => scenario(ctx, 'crash_restart', ['real'], async r => {
  for (const cp of CHECKPOINTS) {
    const since = Date.now(), requestId = crypto.randomUUID();
    const { signal, out } = await child(cp, requestId);
    r.check(`${cp}: worker force-killed at the checkpoint`, signal === 'SIGKILL' && out.includes(`CHECKPOINT ${cp}`), out.trim().slice(0, 300));
    await recoverAfterCrash(ctx, cp, requestId, since, r);
  }
});

const only = process.argv[2] ?? 'all';
if (only !== 'all' && !SCENARIOS.includes(only as never)) throw new Error(`Unknown scenario ${only}`);
const ctx = await prepareHarness(db, harnessConfig(process.env));
const results: ScenarioResult[] = [];
for (const id of SCENARIOS) {
  if (only !== 'all' && only !== id && id !== 'final_broker_state') continue;
  console.log(`▶ ${id}`);
  const res = id === 'crash_restart' ? await crashRestart(ctx) : await SCENARIO_RUNNERS[id](ctx);
  results.push(res); console.log(`  ${res.status.toUpperCase()} — ${res.checks.filter(c => !c.ok).map(c => c.name).join('; ') || 'all checks passed'}`);
}
mkdirSync('docs/certification', { recursive: true });
const file = `docs/certification/phase-1.6-evidence-${ctx.runStartedAt.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ overall: HARNESS_OVERALL_STATUS, runStartedAt: ctx.runStartedAt, finishedAt: new Date().toISOString(),
  config: { ...ctx.cfg }, note: 'Testnet only. Injected faults are labelled by provenance. No certification record was created.', results }, null, 2));
console.log(`Overall: ${HARNESS_OVERALL_STATUS}. Evidence: ${file}`);
