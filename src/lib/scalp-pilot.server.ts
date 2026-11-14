// Live-first milestones B/C — scalp pilot orchestration (server only).
//   1. The signal is RECOMPUTED here from credential-free production public data; a browser signal is never trusted.
//   2. Venue price, filters, balance and positions are read from the executing account's own environment (Testnet
//      prices differ from production), plus the account emergency stop and today's net from the database.
//   3. The Central Risk Engine sizes the proposal; only ACCEPT yields a ticket, which can never exceed that sizing.
//   4. The pilot gate (code constants + approved-config hash + stop + freshness + capital cap) decides submission.
//   5. Submission is ONLY through the protected `openFutures`, which owns limits, the per-account lease, durable intents,
//      production certification, entry, exchange-side SL/TP placement and verification, containment and recovery.
import { evaluateProposal, type RiskContext, type RiskDecision } from "./central-risk";
import type { FuturesTicket } from "./futures";
import { isLiveSymbol, restUrl, type LiveSymbol } from "./live-feed";
import { parseExchangeFilters } from "./live-paper-exec";
import { evaluateLiveSignal, type LiveSignal } from "./live-scalp-signal";
import { decisionToTicket, pilotConfigHash, pilotGate, pilotLimits, pilotProposal, pilotRequestId, PROPOSED_LIVE_PILOT, SCALP_PILOT_VERSION, TESTNET_PILOT, type PilotConfig, type PilotEnvironment, type PilotGate } from "./scalp-pilot";
import { snapshotFromRest } from "./scalp-rest-snapshot";
import { tradeNet } from "./trade-accounting";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
type Account = import("./binance-futures.server").FuturesAccount;
export interface PilotDeps {
  now: () => number;
  publicGet: (url: string) => Promise<unknown>;
  loadAccount: (db: Admin, userId: string, connectionId: string) => Promise<Account>;
  venueGet: <T>(a: Account, path: string, params: Record<string, string | number>, signed: boolean) => Promise<T>;
  openFutures: (db: Admin, userId: string, t: FuturesTicket) => Promise<unknown>;
  requireElite: (db: Admin, userId: string) => Promise<void>;
  log: (line: string) => void;
}
export const defaultPilotDeps = (): PilotDeps => ({
  now: () => Date.now(),
  publicGet: async (url) => { const r = await fetch(url, { method: "GET" }); if (!r.ok) throw new Error(`Binance public ${r.status}`); return r.json(); },
  loadAccount: async (db, u, c) => (await import("./futures.server")).loadFuturesAccount(db, u, c),
  // GET only: this module never sends a POST/DELETE to the exchange itself.
  venueGet: async (a, path, params, signed) => (await import("./binance-futures.server")).futuresCall(a, "GET", path, params, signed),
  openFutures: async (db, u, t) => (await import("./futures.server")).openFutures(db, u, t),
  requireElite: async (db, u) => { await (await import("./plan.server")).requireElite(db, u); },
  log: (l) => console.info(l),
});

export interface PilotPreview {
  version: typeof SCALP_PILOT_VERSION; environment: PilotEnvironment; symbol: LiveSymbol; configHash: string; config: PilotConfig; configStatus: string;
  signal: LiveSignal; venue: { markPrice: number | null; markTime: number | null; minNotional: number | null; availableBalance: number | null } | null;
  decision: RiskDecision | null; ticket: FuturesTicket | null; ticketError: string | null; gate: PilotGate; evaluatedAt: number;
}
const n = (x: unknown) => { const v = Number(x); return x !== null && x !== undefined && x !== "" && Number.isFinite(v) ? v : null; };

export async function previewPilot(db: Admin, userId: string, input: { connectionId: string; symbol: string }, deps: PilotDeps = defaultPilotDeps()): Promise<PilotPreview> {
  if (!isLiveSymbol(input.symbol)) throw new Error("Symbol not supported by the scalp pilot");
  const symbol = input.symbol;
  await deps.requireElite(db, userId);
  const c = await db.from("exchange_connections").select("id,user_id,exchange,status,is_testnet,account_type").eq("id", input.connectionId).eq("user_id", userId).maybeSingle();
  if (c.error || !c.data || c.data.exchange !== "binance" || c.data.status !== "connected" || typeof c.data.is_testnet !== "boolean") throw new Error("Verified owner Binance Futures account required");
  if (c.data.account_type !== "futures" && c.data.account_type !== "both") throw new Error("Select Futures or Both on Exchanges first");
  const env: PilotEnvironment = c.data.is_testnet ? "testnet" : "live", dbEnv = c.data.is_testnet ? "testnet" : "production";
  const config = env === "testnet" ? TESTNET_PILOT : PROPOSED_LIVE_PILOT.config, configHash = await pilotConfigHash(config);
  const configStatus = env === "testnet" ? "Owner's fixed Testnet limits + owner-proposed buffer/age/cost values" : PROPOSED_LIVE_PILOT.status;

  // 1. Server-side signal from production public data (the strategy's market).
  const g = (path: string, params: Record<string, string | number>) => deps.publicGet(restUrl(path, params));
  const [k1, k5, depth, aggTrades, premium] = await Promise.all([
    g("/fapi/v1/klines", { symbol, interval: "1m", limit: 120 }), g("/fapi/v1/klines", { symbol, interval: "5m", limit: 60 }),
    g("/fapi/v1/depth", { symbol, limit: 100 }), g("/fapi/v1/aggTrades", { symbol, limit: 1000 }), g("/fapi/v1/premiumIndex", { symbol }),
  ].map((p) => p.catch(() => null)));
  const signal = evaluateLiveSignal(snapshotFromRest(symbol, { klines1m: k1, klines5m: k5, depth, aggTrades, premium, receivedAt: deps.now() }, deps.now()));
  const now = deps.now(), requestId = await pilotRequestId(signal.id, env);
  const base = { version: SCALP_PILOT_VERSION, environment: env, symbol, configHash, config, configStatus, signal, evaluatedAt: now } as const;
  const halt = await db.from("risk_settings").select("trading_halted").eq("user_id", userId).maybeSingle();
  const emergencyStop: boolean | null = halt.error || !halt.data ? null : Boolean(halt.data.trading_halted);
  if (signal.action !== "LONG" && signal.action !== "SHORT") {
    return { ...base, venue: null, decision: null, ticket: null, ticketError: `signal ${signal.action}`, gate: pilotGate({ environment: env, configHash, decision: null, ticket: null, signalFresh: signal.expiresAt > now, emergencyStop, committedMargin: null, config }) };
  }

  // 2. Executing venue + account (read-only GETs) and database risk evidence.
  const a = await deps.loadAccount(db, userId, input.connectionId);
  const [vp, info, account, positions] = await Promise.all([
    deps.venueGet<Record<string, unknown>>(a, "/fapi/v1/premiumIndex", { symbol }, false).catch(() => null),
    deps.venueGet<{ symbols?: unknown[] }>(a, "/fapi/v1/exchangeInfo", {}, false).catch(() => null),
    deps.venueGet<Record<string, unknown>>(a, "/fapi/v3/account", {}, true).catch(() => null),
    deps.venueGet<Record<string, unknown>[]>(a, "/fapi/v3/positionRisk", {}, true).catch(() => null),
  ]);
  const filters = parseExchangeFilters((info?.symbols ?? []).find((s) => (s as { symbol?: string }).symbol === symbol));
  const markPrice = n(vp?.["markPrice"]), markTime = n(vp?.["time"]);
  const open = positions?.filter((p) => n(p["positionAmt"]) !== 0 && n(p["positionAmt"]) !== null) ?? null;
  const openExposure = open ? open.reduce((s, p) => s + Math.abs(n(p["notional"]) ?? (n(p["positionAmt"])! * (n(p["markPrice"]) ?? 0))), 0) : null;
  const committed = open ? open.reduce((s, p) => s + (n(p["initialMargin"]) ?? n(p["isolatedMargin"]) ?? Number.NaN), 0) : null;
  const committedMargin = committed !== null && Number.isFinite(committed) ? committed : null;
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const [trades, pending, seen] = await Promise.all([
    db.from("trades").select("realized_pnl,fees,funding_pnl,costs_verified").eq("user_id", userId).eq("execution_environment", dbEnv).gte("closed_at", start.toISOString()),
    db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("execution_environment", dbEnv).in("status", ["pending", "open", "partially_filled"]),
    db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("idempotency_key", `futures:${requestId}`),
  ]);
  const unrealized = open ? open.reduce((s, p) => s + Math.min(0, n(p["unRealizedProfit"]) ?? 0), 0) : null;
  const dayNet = trades.error || !trades.data || unrealized === null ? null : trades.data.reduce((s, t) => s + tradeNet(t), 0) + unrealized;
  const ctx: RiskContext = {
    now,
    account: { equity: n(account?.["totalMarginBalance"]), availableMargin: n(account?.["availableBalance"]), openExposure, openPositions: open ? open.length : null, dayNet, halted: emergencyStop, environmentHalted: emergencyStop },
    limits: pilotLimits(config),
    strategy: { budget: config.maxDailyLoss, usedLoss: dayNet === null ? null : Math.max(0, -dayNet) },
    market: { markPrice, markTimestamp: markTime, stepSize: filters?.stepSize ?? null, minNotional: filters?.minNotional ?? null, maintenanceMarginRate: filters?.maintMarginRate ?? null },
    orders: { sameProposalSeen: seen.error ? null : (seen.count ?? 0) > 0, unresolvedOrders: pending.error ? null : pending.count ?? 0, openPositionOnSymbol: open ? open.some((p) => p["symbol"] === symbol) : null },
  };
  const proposal = markPrice ? pilotProposal(signal, env, markPrice, now) : null;
  const decision = evaluateProposal(proposal, ctx);
  const t = decisionToTicket(signal, decision, config, { connectionId: input.connectionId, requestId });
  const ticket = "ticket" in t ? t.ticket : null;
  const gate = pilotGate({ environment: env, configHash, decision, ticket, signalFresh: signal.expiresAt > deps.now(), emergencyStop, committedMargin, config });
  return { ...base, venue: { markPrice, markTime, minNotional: filters?.minNotional ?? null, availableBalance: n(account?.["availableBalance"]) }, decision, ticket, ticketError: "error" in t ? t.error : null, gate };
}

export type PilotSubmitResult = { status: "REFUSED"; code: string; correlationId: string; preview: PilotPreview } | { status: "SUBMITTED"; correlationId: string; preview: PilotPreview; result: unknown };
/** Re-evaluates everything server-side, then either refuses (with an audit line) or hands the ticket to `openFutures`. */
export async function submitPilot(db: Admin, userId: string, input: { connectionId: string; symbol: string }, deps: PilotDeps = defaultPilotDeps()): Promise<PilotSubmitResult> {
  const preview = await previewPilot(db, userId, input, deps), correlationId = `pilot_${crypto.randomUUID()}`;
  const audit = (type: string, extra: Record<string, unknown>) => deps.log(JSON.stringify({ type, correlationId, at: deps.now(), environment: preview.environment, symbol: preview.symbol, signalId: preview.signal.id, action: preview.signal.action, verdict: preview.decision?.verdict ?? null, configHash: preview.configHash, ...extra }));
  if (!preview.gate.allowed || !preview.ticket) { audit("SCALP_PILOT_REFUSED", { code: preview.gate.code, failed: preview.gate.checks.filter((c) => !c.ok).map((c) => c.id) }); return { status: "REFUSED", code: preview.gate.code, correlationId, preview }; }
  audit("SCALP_PILOT_SUBMITTING", { requestId: preview.ticket.requestId, margin: preview.ticket.margin, leverage: preview.ticket.leverage, slPct: preview.ticket.slPct, tpPct: preview.ticket.tpPct });
  const result = await deps.openFutures(db, userId, preview.ticket);
  audit("SCALP_PILOT_SUBMITTED", { requestId: preview.ticket.requestId });
  return { status: "SUBMITTED", correlationId, preview, result };
}
