// Phase 4H.5 — F15 server side: the shared server-function security check and the AI routes refuse a worker identity
// (via account_mfa_allowed(), which draft 0055 makes false for worker identities), every server function needs a
// signed-in caller, and the worker's 0055 envelope decoding is strict. MOCKED backend; nothing real is contacted.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: {} as Record<string, { data: unknown; error: unknown } | "throw"> }));
vi.mock("@tanstack/react-start", () => ({ createMiddleware: () => ({ server: (fn: unknown) => fn }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => ({ headers: new Headers({ authorization: "Bearer test-token" }) }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }), getClaims: async () => ({ data: { claims: { sub: "u", session_id: "s" } }, error: null }) },
  rpc: async (fn: string) => { const r = mocks.rpc[fn]; if (r === "throw") throw new Error("network"); return r ?? { data: null, error: { code: "PGRST202" } }; },
}) }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: () => { const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: { revoked_at: null }, error: null }) }; return c; } } }));
import { accountSecurityMiddleware } from "@/lib/account-security";
import { verifyAiRequest } from "@/lib/ai-auth.server";
import { decodeIdentityEnvelope, IDENTITY_RPC_V2, identityRpcNameV2 } from "@/lib/futures-paper-worker-identity";
const run = accountSecurityMiddleware as unknown as (a: { next: () => Promise<string> }) => Promise<string>;
beforeEach(() => { mocks.rpc = {}; vi.stubEnv("SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-public-key"); });

describe("shared server-function security check", () => {
  it("refuses a worker identity with a clear message and never runs the server function", async () => {
    mocks.rpc = { account_mfa_allowed: { data: false, error: null }, fpw_caller_is_worker: { data: true, error: null } };
    const next = vi.fn(async () => "unsafe");
    await expect(run({ next })).rejects.toThrow("This account is a background worker identity and cannot use the app");
    expect(next).not.toHaveBeenCalled();
  });
  it("the refusal never depends on the worker lookup: missing (before 0055), failing or false lookups still refuse", async () => {
    for (const w of [undefined, "throw", { data: null, error: { code: "PGRST202" } }, { data: false, error: null }] as const) {
      mocks.rpc = { account_mfa_allowed: { data: false, error: null }, ...(w ? { fpw_caller_is_worker: w as never } : {}) };
      await expect(run({ next: async () => "unsafe" })).rejects.toThrow("Verify your authenticator code to continue");
    }
  });
  it("an ordinary allowed user is unaffected (one lookup, no worker lookup)", async () => {
    mocks.rpc = { account_mfa_allowed: { data: true, error: null }, fpw_caller_is_worker: "throw" };
    await expect(run({ next: async () => "allowed" })).resolves.toBe("allowed");
  });
  it("the AI routes refuse a caller for whom account_mfa_allowed() is false (a worker identity under 0055)", async () => {
    mocks.rpc = { account_mfa_allowed: { data: false, error: null } };
    const r = await verifyAiRequest(new Request("https://x.invalid/api/chat", { headers: { authorization: "Bearer t" } }), "plan");
    expect((r as Response).status).toBe(403);
  });
});

describe("every server entry point that acts for a user goes through those checks", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  it("the security check is registered globally for every server function", () => {
    expect(readFileSync("src/start.ts", "utf8")).toMatch(/functionMiddleware:\s*\[attachSupabaseAuth,\s*accountSecurityMiddleware\]/);
  });
  it("every server function requires a signed-in caller (so the global check always sees a token)", () => {
    const files = walk("src").filter((f) => !f.startsWith(join("src", "test")) && /createServerFn\(/.test(readFileSync(f, "utf8")));
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) { const s = readFileSync(f, "utf8"); expect([f, (s.match(/createServerFn\(/g) ?? []).length], f).toEqual([f, (s.match(/\.middleware\(\[requireSupabaseAuth/g) ?? []).length]); }
  });
  it("the signed-in API routes verify through verifyAiRequest; the public routes never act on a user's bearer token", () => {
    const routes = walk("src/routes/api").filter((f) => !f.startsWith(join("src", "routes", "api", "public")));
    expect(routes.sort()).toEqual([join("src", "routes", "api", "autopilot.ts"), join("src", "routes", "api", "chat.ts")]);
    expect(readFileSync("src/routes/api/chat.ts", "utf8")).toMatch(/handleChat\(request\)/);
    expect(readFileSync("src/routes/api/autopilot.ts", "utf8")).toMatch(/handleAutopilot\(request\)/);
    for (const f of ["src/lib/chat.server.ts", "src/lib/autopilot.server.ts"]) expect(readFileSync(f, "utf8"), f).toMatch(/const caller = await verifyAiRequest\(request,/);
    for (const f of walk("src/routes/api/public")) expect(readFileSync(f, "utf8"), f).not.toMatch(/getClaims|auth\.getUser|verifyAiRequest|requireSupabaseAuth/);
    expect(readFileSync("src/lib/ai-auth.server.ts", "utf8")).toMatch(/rpc\("account_mfa_allowed"\)/);
  });
});

describe("the 0055 envelope as seen by the worker", () => {
  it("maps exactly the six operations and decodes strictly (anything unexpected is an UNKNOWN outcome, never 'nothing written')", () => {
    expect(Object.values(IDENTITY_RPC_V2).sort()).toEqual(["fpw_id2_acquire_lease", "fpw_id2_commit", "fpw_id2_evaluated", "fpw_id2_mark_review", "fpw_id2_release_lease", "fpw_id2_snapshot"]);
    expect(() => identityRpcNameV2("fpw_id2_commit")).toThrow(/not allowlisted/);
    expect(decodeIdentityEnvelope({ ok: true, data: 5 })).toEqual({ data: 5, error: null, status: 200 });
    expect(decodeIdentityEnvelope({ ok: true, data: null })).toEqual({ data: null, error: null, status: 200 });
    expect(decodeIdentityEnvelope({ ok: false, sqlstate: "P0001", message: "m" })).toEqual({ data: null, error: { code: "P0001", message: "m" }, status: 400 });
    for (const b of [null, 5, "x", [], { ok: true }, { ok: false }, { ok: false, sqlstate: "bad" }, { ok: "true", data: 1 }]) expect(decodeIdentityEnvelope(b).status, JSON.stringify(b)).toBe(0);
  });
});
