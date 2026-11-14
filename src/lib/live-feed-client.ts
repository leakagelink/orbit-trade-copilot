// Phase 4H.8 — connection manager for the public Binance USD-M live feed. Browser- and Bun-safe (standard WebSocket and
// fetch, both injectable for tests). Two sockets (/market and /public); the stream list is part of the URL, so every
// reconnect re-subscribes exactly the same streams. Reconnects use capped exponential back-off with jitter; a silent
// socket is closed and reopened by the watchdog; every disconnect invalidates the local books, which resynchronise from a
// fresh REST snapshot under the rate governor. Public data only: no key, no signed request, no order endpoint exists here.
import { FeedEngine, RestGovernor, restUrl, socketUrl, type FeedEvent, type LiveInterval, type LiveSymbol, type SocketKind } from "./live-feed";

export interface SocketLike { readyState: number; close(code?: number, reason?: string): void; onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null }
export interface ClientDeps {
  WebSocketImpl: new (url: string) => SocketLike;
  fetchImpl: (url: string, init: { method: "GET"; signal: AbortSignal; credentials: "omit" }) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown> }>;
  now: () => number; random: () => number;
  setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void;
}
export interface ClientOptions { backoffBaseMs: number; backoffMaxMs: number; watchdogMs: number; silentReconnectMs: number; maxConnectionMs: number; restTimeoutMs: number; klineBootstrap: number; serverTimeEveryMs: number; backfillEveryMs: number }
export const DEFAULT_CLIENT_OPTIONS: ClientOptions = { backoffBaseMs: 500, backoffMaxMs: 30_000, watchdogMs: 1_000, silentReconnectMs: 10_000, maxConnectionMs: 23 * 3_600_000, restTimeoutMs: 5_000, klineBootstrap: 200, serverTimeEveryMs: 300_000, backfillEveryMs: 30_000 };

interface Sock { ws: SocketLike | null; state: "idle" | "connecting" | "open" | "closed"; connectedAt: number | null; lastMessageAt: number | null; attempts: number; reconnects: number; timer: unknown }
export interface ClientMetrics {
  sockets: Record<SocketKind, { state: Sock["state"]; connectedAt: number | null; lastMessageAt: number | null; reconnects: number; attempts: number }>;
  processing: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }; rest: { requests: number; errors: number; limited: number; backoffUntil: number };
}

export class LiveFeedClient {
  readonly governor = new RestGovernor();
  private socks: Record<SocketKind, Sock> = { market: this.blank(), public: this.blank() };
  private stopped = true; private watchdog: unknown = null; private aborts = new Set<AbortController>();
  private snapInFlight = new Set<LiveSymbol>(); private snapRetryAt = new Map<LiveSymbol, number>(); private snapAttempts = new Map<LiveSymbol, number>();
  private backfillAt = new Map<string, number>(); private serverTimeAt = 0; private proc: number[] = []; private procCount = 0; private procMax = 0;
  private rest = { requests: 0, errors: 0 };
  readonly opts: ClientOptions;
  /** Receives every ACCEPTED event (after validation and de-duplication), synchronously. Never throws into the feed. */
  onEvent: ((e: FeedEvent) => void) | null = null;
  constructor(readonly engine: FeedEngine, private d: ClientDeps, opts: Partial<ClientOptions> = {}) { this.opts = { ...DEFAULT_CLIENT_OPTIONS, ...opts }; }
  private blank(): Sock { return { ws: null, state: "idle", connectedAt: null, lastMessageAt: null, attempts: 0, reconnects: 0, timer: null }; }

  start() {
    if (!this.stopped) return; this.stopped = false;
    this.connect("market"); this.connect("public");
    void this.syncServerTime();
    for (const s of this.engine.symbols) for (const iv of ["1m", "5m"] as LiveInterval[]) void this.loadKlines(s, iv);
    this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.watchdog !== null) this.d.clearTimeout(this.watchdog); this.watchdog = null;
    for (const k of ["market", "public"] as SocketKind[]) { const s = this.socks[k]; if (s.timer !== null) this.d.clearTimeout(s.timer); s.timer = null; const ws = s.ws; s.ws = null; s.state = "closed"; if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(1000, "stopped"); } catch { /* ignore */ } } }
    for (const a of this.aborts) a.abort(); this.aborts.clear();
  }
  get running() { return !this.stopped; }

  private connect(kind: SocketKind) {
    if (this.stopped) return;
    const s = this.socks[kind]; s.timer = null; s.state = "connecting";
    let ws: SocketLike;
    try { ws = new this.d.WebSocketImpl(socketUrl(kind, this.engine.symbols)); } catch (e) { this.onDown(kind, `constructor failed: ${(e as Error).message}`); return; }
    s.ws = ws;
    ws.onopen = () => { if (s.ws !== ws) return; s.state = "open"; s.connectedAt = this.d.now(); s.lastMessageAt = s.connectedAt; if (s.attempts > 0) s.reconnects++; s.attempts = 0; this.engine.markReconnected(kind, s.connectedAt); this.engine.monitor.emit("WS_CONNECTED", "info", null, { socket: kind, reconnects: s.reconnects }); };
    ws.onmessage = (ev) => {
      if (s.ws !== ws || this.stopped) return;
      const t0 = this.d.now(); s.lastMessageAt = t0;
      const e = this.engine.ingest(ev.data, t0);
      if (e?.kind === "depth" && this.engine.needsSnapshot(e.symbol)) this.maybeSnapshot(e.symbol);
      if (e && this.onEvent) { try { this.onEvent(e); } catch (err) { this.engine.monitor.emit("PAPER_ERROR", "error", e.symbol, { stage: "listener", error: String((err as Error)?.message ?? err).slice(0, 160) }); } }
      const dt = this.d.now() - t0; this.proc.push(dt); if (this.proc.length > 1000) this.proc.shift(); this.procCount++; if (dt > this.procMax) this.procMax = dt;
    };
    ws.onclose = () => { if (s.ws === ws) this.onDown(kind, "closed"); };
    ws.onerror = () => { if (s.ws === ws) { try { ws.close(); } catch { /* ignore */ } this.onDown(kind, "error"); } };
  }
  private onDown(kind: SocketKind, why: string) {
    const s = this.socks[kind]; if (s.ws) { s.ws.onopen = s.ws.onmessage = s.ws.onclose = s.ws.onerror = null; } s.ws = null; s.state = "closed";
    if (kind === "public") this.engine.invalidateBooks("SOCKET_CLOSED");
    this.engine.monitor.emit("WS_DISCONNECTED", "warn", null, { socket: kind, why });
    if (this.stopped || s.timer !== null) return;
    const base = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.min(s.attempts, 16)), delay = Math.round(base * (0.5 + 0.5 * this.d.random()));
    s.attempts++;
    this.engine.monitor.emit("WS_RECONNECT_SCHEDULED", "info", null, { socket: kind, delayMs: delay, attempt: s.attempts });
    s.timer = this.d.setTimeout(() => this.connect(kind), delay);
  }
  /** Closes a socket on purpose (watchdog, proactive renewal, tests); the normal reconnect path follows. */
  forceReconnect(kind: SocketKind, why: string) { const s = this.socks[kind]; const ws = s.ws; if (!ws) return; try { ws.close(4000, why); } catch { /* ignore */ } this.onDown(kind, why); }

  private tick() {
    if (this.stopped) return;
    const now = this.d.now();
    this.engine.checkStale(now);
    for (const k of ["market", "public"] as SocketKind[]) {
      const s = this.socks[k];
      if (s.state === "open" && s.lastMessageAt !== null && now - s.lastMessageAt > this.opts.silentReconnectMs) this.forceReconnect(k, "silent socket");
      else if (s.state === "open" && s.connectedAt !== null && now - s.connectedAt > this.opts.maxConnectionMs) this.forceReconnect(k, "connection renewal");
    }
    for (const sym of this.engine.symbols) {
      if (this.engine.needsSnapshot(sym)) this.maybeSnapshot(sym);
      const h = this.engine.health(sym, now);
      for (const iv of ["1m", "5m"] as LiveInterval[]) { const key = `${sym}:${iv}`; if (h.candleGaps[iv] !== null && (this.backfillAt.get(key) ?? 0) <= now) { this.backfillAt.set(key, now + this.opts.backfillEveryMs); void this.loadKlines(sym, iv); } }
    }
    if (now - this.serverTimeAt > this.opts.serverTimeEveryMs) void this.syncServerTime();
    this.watchdog = this.d.setTimeout(() => this.tick(), this.opts.watchdogMs);
  }

  private async get(path: string, params: Record<string, string | number>): Promise<{ body: unknown; sentAt: number; receivedAt: number } | null> {
    const now = this.d.now(), g = this.governor.canSend(path, now);
    if (!g.ok) { this.engine.monitor.emit("RATE_LIMITED", "warn", typeof params["symbol"] === "string" ? params["symbol"] : null, { path, reason: g.reason, retryAt: g.retryAt }); return null; }
    const ac = new AbortController(); this.aborts.add(ac);
    const timer = this.d.setTimeout(() => ac.abort(), this.opts.restTimeoutMs);
    this.rest.requests++;
    try {
      const r = await this.d.fetchImpl(restUrl(path, params), { method: "GET", signal: ac.signal, credentials: "omit" });
      const receivedAt = this.d.now();
      this.governor.onResponse(r.status, r.headers.get("x-mbx-used-weight-1m"), r.headers.get("retry-after"), receivedAt);
      if (!r.ok) { this.rest.errors++; this.engine.monitor.emit(r.status === 429 || r.status === 418 ? "RATE_LIMITED" : "REST_ERROR", "warn", null, { path, status: r.status }); return null; }
      return { body: await r.json(), sentAt: now, receivedAt };
    } catch (e) {
      this.rest.errors++; if (!this.stopped) this.engine.monitor.emit("REST_ERROR", "warn", null, { path, error: ac.signal.aborted ? "timeout or stopped" : String((e as Error)?.message ?? e).slice(0, 120) });
      return null;
    } finally { this.d.clearTimeout(timer); this.aborts.delete(ac); }
  }
  private maybeSnapshot(sym: LiveSymbol) {
    if (this.stopped || this.snapInFlight.has(sym) || this.socks.public.state !== "open" || (this.snapRetryAt.get(sym) ?? 0) > this.d.now()) return;
    if (this.engine.bookSizes(sym).buffer === 0) return; // buffer diffs first, as the procedure requires
    this.snapInFlight.add(sym);
    void this.get("/fapi/v1/depth", { symbol: sym, limit: 1000 }).then((r) => {
      this.snapInFlight.delete(sym);
      const ok = r !== null && this.engine.applySnapshot(sym, r.body, r.receivedAt);
      const n = ok ? 0 : (this.snapAttempts.get(sym) ?? 0) + 1; this.snapAttempts.set(sym, n);
      this.snapRetryAt.set(sym, ok ? 0 : this.d.now() + Math.min(30_000, 1_000 * 2 ** Math.min(n, 5)));
    });
  }
  private async loadKlines(sym: LiveSymbol, iv: LiveInterval) {
    const r = await this.get("/fapi/v1/klines", { symbol: sym, interval: iv, limit: this.opts.klineBootstrap });
    if (r) this.engine.mergeKlines(sym, iv, r.body, r.receivedAt);
  }
  private async syncServerTime() { this.serverTimeAt = this.d.now(); const r = await this.get("/fapi/v1/time", {}); if (r) this.engine.setServerTime(r.body, r.sentAt, r.receivedAt); }

  metrics(): ClientMetrics {
    const p = [...this.proc].sort((a, b) => a - b), q = (f: number) => (p.length ? p[Math.min(p.length - 1, Math.floor(p.length * f))]! : null);
    const sock = (k: SocketKind) => { const s = this.socks[k]; return { state: s.state, connectedAt: s.connectedAt, lastMessageAt: s.lastMessageAt, reconnects: s.reconnects, attempts: s.attempts }; };
    return { sockets: { market: sock("market"), public: sock("public") }, processing: { count: this.procCount, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: p.length ? this.procMax : null }, rest: { ...this.rest, limited: this.governor.limited, backoffUntil: this.governor.backoffUntil } };
  }
}

/** Standard platform dependencies (browser or Bun). */
export function platformDeps(): ClientDeps {
  return {
    WebSocketImpl: globalThis.WebSocket as unknown as ClientDeps["WebSocketImpl"],
    fetchImpl: (u, i) => globalThis.fetch(u, i) as never,
    now: () => Date.now(), random: Math.random,
    setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}
