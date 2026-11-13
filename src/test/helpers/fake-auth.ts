// Test-only fake auth server pieces for the worker session lifecycle (Phase 4H.2). Tokens are unsigned look-alikes;
// nothing here talks to a network or a real auth service.
import type { AuthReply, WorkerAuthTransport } from "@/lib/worker-auth-session";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const fakeJwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${Buffer.from("sig-" + Math.random()).toString("base64url")}`;
export const WORKER = "00000000-0000-4000-8000-0000000c0de1";
export function issued(now: number, o: { sub?: string; role?: string; lifeSec?: number; expiresIn?: number | null; iatSec?: number; access?: string; refresh?: string } = {}) {
  const life = o.lifeSec ?? 3600, sub = o.sub ?? WORKER;
  const access = o.access ?? fakeJwt({ sub, role: o.role ?? "authenticated", exp: Math.floor(now / 1000) + life, iat: o.iatSec ?? Math.floor(now / 1000), aud: "authenticated" });
  return { access_token: access, refresh_token: o.refresh ?? `rt-${Math.random().toString(36).slice(2, 14)}`, token_type: "bearer", expires_in: o.expiresIn === null ? undefined : (o.expiresIn ?? life), user: { id: sub } };
}
export type Step = AuthReply | "throw" | "hang" | ((signal: AbortSignal) => Promise<AuthReply>);
export interface FakeAuth extends WorkerAuthTransport { log: string[]; signOutTokens: string[]; refreshTokens: string[] }
/** Each list is consumed in order; a missing entry replies 500. */
export function fakeAuth(steps: { signIn?: Step[]; refresh?: Step[]; signOut?: Step[] }): FakeAuth {
  const log: string[] = [], signOutTokens: string[] = [], refreshTokens: string[] = [];
  const run = (list: Step[] | undefined, signal: AbortSignal): Promise<AuthReply> => {
    const s = list?.shift() ?? { status: 500, body: null };
    if (s === "throw") return Promise.reject(new TypeError("fetch failed"));
    if (s === "hang") return new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    if (typeof s === "function") return s(signal);
    return Promise.resolve(s);
  };
  return {
    log, signOutTokens, refreshTokens,
    signIn: (signal) => { log.push("signIn"); return run(steps.signIn, signal); },
    refresh: (rt, signal) => { log.push("refresh"); refreshTokens.push(rt); return run(steps.refresh, signal); },
    signOut: (at, signal) => { log.push("signOut"); signOutTokens.push(at); return run(steps.signOut, signal); },
  };
}
export const ok = (body: unknown): AuthReply => ({ status: 200, body });
export const noContent: AuthReply = { status: 204, body: null };
