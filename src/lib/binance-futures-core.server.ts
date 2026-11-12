// Shared request machinery for the two separate Binance USD-M adapters. Each adapter instance is frozen to one
// environment and one base URL; every request is validated before it is signed or sent. One fetch per call:
// a non-GET timeout is reported as "outcome unknown" and is never retried here (callers settle by lookup only).
import { prepareCall, finishCall, type FaultPlan } from "./futures-faults.server";
import { BINANCE_FUTURES_BASE_URLS, futuresRequestProblem, futuresUrlProblem, withEnv, type ApiCredentials, type FuturesEnvironment } from "./binance-futures-env";

export type FuturesMethod = "GET" | "POST" | "DELETE";
export interface FuturesRequestAccount { testnet: boolean; creds: ApiCredentials; faults?: FaultPlan | undefined }
export interface FuturesAdapter {
  readonly environment: FuturesEnvironment;
  readonly baseUrl: string;
  call<T>(a: FuturesRequestAccount, method: FuturesMethod, path: string, params?: Record<string, string | number>, signed?: boolean): Promise<T>;
}
const short = (e: unknown) => String(e instanceof Error ? `${e.name}: ${e.message}` : e).slice(0, 160);

export function createFuturesAdapter(environment: FuturesEnvironment, baseUrl: string): FuturesAdapter {
  if (BINANCE_FUTURES_BASE_URLS[environment] !== baseUrl) throw new Error(withEnv(environment === "testnet", "Binance Futures adapter base URL mismatch"));
  const refuse = (why: string) => new Error(withEnv(environment, `Binance Futures request refused before sending: ${why}`));
  async function call<T>(a: FuturesRequestAccount, method: FuturesMethod, path: string, params: Record<string, string | number> = {}, signed = true): Promise<T> {
    // 1. Environment, endpoint and credential binding, before anything else.
    const problem = futuresRequestProblem({ adapterEnvironment: environment, adapterBaseUrl: baseUrl, accountTestnet: a.testnet, credentials: a.creds, signed, method, path, hasFaults: !!a.faults });
    if (problem) throw refuse(problem);
    // 2. Testnet-only fault injection (inert without a plan).
    let fault: ReturnType<typeof prepareCall> | null = null;
    if (a.faults) { try { fault = prepareCall(a.faults, a.testnet, method, path, params); } catch (e) { throw new Error(withEnv(environment, e instanceof Error ? e.message : String(e))); } params = fault.params; }
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    if (signed) {
      qs.set("timestamp", String(Date.now())); qs.set("recvWindow", "10000");
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", enc.encode(a.creds.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(qs.toString())));
      qs.set("signature", Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
    // 3. Final URL check against the frozen base URL.
    const url = new URL(path, baseUrl); url.search = qs.toString();
    const urlProblem = futuresUrlProblem(url, baseUrl, path);
    if (urlProblem) throw refuse(urlProblem);
    let r: Response;
    try {
      r = await fetch(url.toString(), { method, headers: signed ? { "X-MBX-APIKEY": a.creds.apiKey } : {}, signal: AbortSignal.timeout(12000) });
    } catch (e) {
      throw new Error(withEnv(environment, method === "GET"
        ? `Binance Futures ${method} ${path} unavailable (${short(e)})`
        : `Binance Futures ${method} ${path} outcome unknown (${short(e)}); lookup only, never resubmitted`));
    }
    if (!r.ok) { let j: { code?: number; msg?: string } = {}; try { j = await r.json(); } catch { /* body unavailable */ } throw new Error(withEnv(environment, `Binance Futures ${r.status}${j.code ? ` (${j.code})` : ""}: ${j.msg ?? "request unavailable"}`)); }
    const body = await r.json();
    if (!fault?.rule) return body as T;
    try { return finishCall(fault.rule, body) as T; } catch (e) { throw new Error(withEnv(environment, e instanceof Error ? e.message : String(e))); }
  }
  return Object.freeze({ environment, baseUrl, call });
}
