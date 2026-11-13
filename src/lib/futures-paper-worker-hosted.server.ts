// Server-only binding of the hosted Futures PAPER worker connection (Phase 4G) — DISABLED. Nothing imports this file;
// no route, server function, cron entry, scheduler or background job calls it. It refuses to build unless the
// environment flag FUTURES_PAPER_WORKER_HOSTED is exactly "enabled" (it is set nowhere) AND draft migrations 0049/0050
// have been applied by separate owner approval. The service credential stays inside the generated server client: this
// file never reads, returns, logs or forwards a key, and it can call ONLY the six allowlisted gateway functions.
import { HOSTED_WORKER_RPCS, type HostedRpc } from "./futures-paper-worker-hosted";

type RpcClient = { rpc(fn: string, args: Record<string, unknown>): { abortSignal(s: AbortSignal): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null; status: number }> } };

export async function hostedFuturesPaperRpc(): Promise<HostedRpc> {
  if (process.env["FUTURES_PAPER_WORKER_HOSTED"] !== "enabled") throw new Error("hosted futures paper worker is disabled");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const client = supabaseAdmin as unknown as RpcClient;
  return async (fn, args, signal) => {
    if (!(HOSTED_WORKER_RPCS as readonly string[]).includes(fn)) throw new Error("hosted futures paper worker: function not allowlisted");
    const r = await client.rpc(fn, args).abortSignal(signal);
    return { data: r.data, error: r.error ? { code: r.error.code ?? null, message: r.error.message ?? null } : null, status: r.status };
  };
}
