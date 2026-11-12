// Child process for the crash/restart scenario: runs one real Testnet entry and force-kills itself (SIGKILL — no finally
// blocks, no lease release) at the named checkpoint. Run only by scripts/futures-harness/run.ts.
import { writeSync } from 'node:fs';
import { supabaseAdmin as db } from '@/integrations/supabase/client.server';
import { harnessConfig, prepareHarness, ticket } from '@/lib/futures-harness.server';
import type { FuturesCheckpoint } from '@/lib/futures.server';

const [target, requestId] = process.argv.slice(2) as [FuturesCheckpoint, string];
const cfg = harnessConfig(process.env);
const ctx = await prepareHarness(db, cfg);
const { openFutures } = await import('@/lib/futures.server');
try {
  await openFutures(db, cfg.testUserId, ticket(ctx, { requestId }), {
    checkpoint: name => { if (name === target) { writeSync(1, `CHECKPOINT ${name}\n`); process.kill(process.pid, 'SIGKILL'); } },
  });
  writeSync(1, 'COMPLETED_WITHOUT_CRASH\n');
} catch (e) { writeSync(1, `ENTRY_FAILED ${String(e).slice(0, 300)}\n`); }
