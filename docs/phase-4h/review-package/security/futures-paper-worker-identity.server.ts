// Server-only binding of the Futures PAPER worker as a dedicated SIGNED-IN identity (Phase 4H finalization, DRAFT 0053
// — not applied) — DISABLED. Nothing imports this file; no route, server function, cron entry, scheduler or background
// job calls it. It refuses to build unless BOTH FUTURES_PAPER_WORKER_HOSTED is exactly "enabled" and
// FUTURES_PAPER_WORKER_IDENTITY is exactly "signed-in" (neither is set anywhere), and its credentials
// (FUTURES_PAPER_WORKER_EMAIL / FUTURES_PAPER_WORKER_PASSWORD, server-only secrets) exist. It never uses the service
// key or the admin client: it signs in with the publishable key like any user, so row-level security and the 0053
// registry/enrollment checks apply. It never reads back, returns, logs or forwards a credential or token, and can call
// ONLY the six 0053 wrappers (mapped from the Phase 4G allowlist).
import { createClient } from "@supabase/supabase-js";
import type { HostedRpc } from "./futures-paper-worker-hosted";
import { identityRpcName, WorkerIdentityError } from "./futures-paper-worker-identity";

export async function identityFuturesPaperRpc(): Promise<HostedRpc> {
  if (process.env["FUTURES_PAPER_WORKER_HOSTED"] !== "enabled" || process.env["FUTURES_PAPER_WORKER_IDENTITY"] !== "signed-in") throw new WorkerIdentityError("IDENTITY_DISABLED");
  const url = process.env["SUPABASE_URL"], key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const email = process.env["FUTURES_PAPER_WORKER_EMAIL"], password = process.env["FUTURES_PAPER_WORKER_PASSWORD"];
  if (!url || !key || !email || !password) throw new WorkerIdentityError("IDENTITY_NOT_CONFIGURED");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new WorkerIdentityError("IDENTITY_SIGN_IN_FAILED"); // provider text is not forwarded
  return async (fn, args, signal) => {
    const r = await client.rpc(identityRpcName(fn), args).abortSignal(signal);
    return { data: r.data, error: r.error ? { code: r.error.code ?? null, message: r.error.message ?? null } : null, status: r.status };
  };
}
