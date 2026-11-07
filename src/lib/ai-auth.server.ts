// Shared bearer verification for AI server routes (assistant chat, autopilot). Returns the caller's RLS client or an error Response.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export function userClient(token: string) {
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

export type AiCaller = { supabase: SupabaseClient<Database>; userId: string };

/** Verifies token, MFA, live user and workspace-session revocation, then the Pro plan. */
export async function verifyAiRequest(request: Request, planMessage: string): Promise<AiCaller | Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return new Response("Unauthorized", { status: 401 });
  const supabase = userClient(token);
  const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
  if (authErr || !claims?.claims?.sub) return new Response("Unauthorized", { status: 401 });
  const mfa = await supabase.rpc("account_mfa_allowed");
  if (mfa.error || mfa.data !== true) return new Response("Authenticator verification required", { status: 403 });
  const verified = await supabase.auth.getUser(token);
  if (verified.error || !verified.data.user) return new Response("Sign in again", { status: 401 });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const sessionId = claims.claims.session_id;
  if (typeof sessionId === "string") {
    const active = await supabaseAdmin.from("workspace_sessions").select("revoked_at").eq("id", sessionId).maybeSingle();
    if (active.error || active.data?.revoked_at) return new Response("Session revoked", { status: 403 });
  }
  const { hasPro } = await import("./plan.server");
  if (!(await hasPro(supabase, claims.claims.sub))) return new Response(planMessage, { status: 402 });
  return { supabase, userId: claims.claims.sub };
}
