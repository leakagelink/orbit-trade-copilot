// Phase 4H.8 — connection manager with a fake WebSocket, fake fetch and a manual clock (deterministic).
import { describe, expect, it } from "vitest";
import { FeedEngine } from "@/lib/live-feed";
import { LiveFeedClient, type ClientDeps, type SocketLike } from "@/lib/live-feed-client";

class FakeWS implements SocketLike {
  static all: FakeWS[] = [];
  readyState = 0; onopen: SocketLike["onopen"] = null; onmessage: SocketLike["onmessage"] = null; onclose: SocketLike["onclose"] = null; onerror: SocketLike["onerror"] = null; closed = false;
  constructor(readonly url: string) { FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  close() { this.closed = true; this.readyState = 3; }
}
function harness(o: { fetchStatus?: number; random?: number } = {}) {
  FakeWS.all = [];
  let now = 1_000_000; const timers: { at: number; f: () => void; id: number }[] = []; let id = 0; const fetches: string[] = [];
  const deps: ClientDeps = {
    WebSocketImpl: FakeWS as never, now: () => now, random: () => o.random ?? 0.5,
    setTimeout: (f, ms) => { const t = { at: now + ms, f, id: ++id }; timers.push(t); return t.id; },
    clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    fetchImpl: async (url) => {
      fetches.push(url);
      const body = url.includes("/depth") ? { lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "1"]] } : url.includes("/time") ? { serverTime: now } : [];
      return { ok: (o.fetchStatus ?? 200) === 200, status: o.fetchStatus ?? 200, headers: { get: (k: string) => (k === "retry-after" ? "5" : k === "x-mbx-used-weight-1m" ? "10" : null) }, json: async () => body };
    },
  };
  const advance = async (ms: number) => { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.f(); await Promise.resolve(); } now = end; await new Promise((r) => setTimeout(r, 0)); };
  const engine = new FeedEngine(["BTCUSDT"]), client = new LiveFeedClient(engine, deps);
  return { engine, client, advance, fetches, timers, get now() { return now; } };
}
const depth = (U: number, u: number, pu: number, E = 1) => ({ stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", E, T: E, s: "BTCUSDT", U, u, pu, b: [["99", "2"]], a: [] } });
const sock = (kind: "market" | "public") => FakeWS.all.filter((w) => w.url.includes(`/${kind}/`)).at(-1)!;

describe("LiveFeedClient", () => {
  it("opens exactly the two allowlisted sockets and bootstraps klines and server time over public REST only", async () => {
    const h = harness(); h.client.start(); await h.advance(1);
    expect(FakeWS.all.map((w) => w.url)).toEqual(["wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@kline_1m/btcusdt@kline_5m", "wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms/btcusdt@bookTicker"]);
    expect(h.fetches.every((u) => u.startsWith("https://fapi.binance.com/fapi/v1/") && !/signature|apiKey|order/i.test(u))).toBe(true);
    expect(h.fetches.some((u) => u.includes("/klines?symbol=BTCUSDT&interval=1m"))).toBe(true);
    h.client.stop();
  });
  it("buffers depth, then fetches one snapshot; the buffered diff bridging lastUpdateId synchronises the book", async () => {
    const h = harness(); h.client.start(); sock("public").open();
    expect(h.fetches.filter((u) => u.includes("/depth")).length).toBe(0); // nothing buffered yet: no snapshot
    sock("public").send(depth(95, 105, 94)); await h.advance(10);
    expect(h.fetches.filter((u) => u.includes("/depth")).length).toBe(1);
    expect(h.engine.health("BTCUSDT", h.now).book).toBe("SYNCED");
    sock("public").send(depth(106, 110, 105)); expect(h.engine.depth("BTCUSDT", h.now)!.bids[0]).toEqual([99, 2]);
    sock("public").send(depth(106, 110, 105)); await h.advance(10);
    expect(h.fetches.filter((u) => u.includes("/depth")).length).toBe(1); // a duplicate never triggers another snapshot
    h.client.stop();
  });
  it("reconnects with capped exponential back-off and re-subscribes the same streams; the book is invalidated and resynced", async () => {
    const h = harness({ random: 1 }); h.client.start(); const first = sock("public"); first.open();
    first.send(depth(95, 105, 94)); await h.advance(10); first.send(depth(106, 110, 105));
    expect(h.engine.health("BTCUSDT", h.now).book).toBe("SYNCED");
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) { const before = FakeWS.all.length; sock("public").drop(); delays.push(h.engine.monitor.events.filter((e) => e.type === "WS_RECONNECT_SCHEDULED").at(-1)!.detail["delayMs"] as number); await h.advance(60_000); expect(FakeWS.all.length).toBe(before + 1); }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(new Set(FakeWS.all.filter((w) => w.url.includes("/public/")).map((w) => w.url)).size).toBe(1);
    expect(h.engine.depth("BTCUSDT", h.now)).toBeNull();
    sock("public").open(); expect(h.client.metrics().sockets.public.attempts).toBe(0);
    sock("public").send(depth(200, 210, 199)); await h.advance(10);
    expect(h.fetches.filter((u) => u.includes("/depth")).length).toBe(2);
    h.client.stop();
  });
  it("jitter keeps the delay within [50 %, 100 %] of the back-off step", async () => {
    const lo = harness({ random: 0 }); lo.client.start(); sock("market").drop();
    expect(lo.engine.monitor.events.find((e) => e.type === "WS_RECONNECT_SCHEDULED")!.detail["delayMs"]).toBe(250); lo.client.stop();
  });
  it("a silent open socket is closed by the watchdog and reopened (stale-feed recovery)", async () => {
    const h = harness(); h.client.start(); sock("market").open(); sock("public").open();
    const n = FakeWS.all.length; await h.advance(11_000);
    expect(h.engine.monitor.events.some((e) => e.type === "WS_DISCONNECTED" && e.detail["why"] === "silent socket")).toBe(true);
    await h.advance(2_000); expect(FakeWS.all.length).toBeGreaterThan(n);
    h.client.stop();
  });
  it("stop() closes sockets, cancels timers and never reconnects", async () => {
    const h = harness(); h.client.start(); sock("market").open(); h.client.stop();
    const n = FakeWS.all.length; await h.advance(120_000);
    expect(FakeWS.all.length).toBe(n); expect(FakeWS.all.every((w) => w.closed)).toBe(true); expect(h.timers.length).toBe(0); expect(h.client.running).toBe(false);
  });
  it("429 responses trigger back-off and RATE_LIMITED, never a request storm", async () => {
    const h = harness({ fetchStatus: 429 }); h.client.start(); await h.advance(1);
    const n = h.fetches.length;
    expect(h.engine.monitor.counts["RATE_LIMITED"]).toBeGreaterThan(0);
    sock("public").open(); sock("public").send(depth(95, 105, 94)); await h.advance(30_000);
    expect(h.fetches.length).toBe(n); // every later request is held back by the governor
    h.client.stop();
  });
  it("a throwing listener is reported and does not break the feed", async () => {
    const h = harness(); h.client.start(); sock("market").open();
    h.client.onEvent = () => { throw new Error("listener bug"); };
    sock("market").send({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: 1, a: 1, s: "BTCUSDT", p: "1", q: "1", T: 1, m: true } });
    sock("market").send({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: 2, a: 2, s: "BTCUSDT", p: "1", q: "1", T: 2, m: true } });
    expect(h.engine.trades("BTCUSDT").length).toBe(2); expect(h.engine.monitor.counts["PAPER_ERROR"]).toBe(2);
    h.client.stop();
  });
  it("10,000 messages keep memory bounded and processing latency is measured", async () => {
    const h = harness(); h.client.start(); sock("market").open();
    for (let i = 1; i <= 10_000; i++) sock("market").send({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: h.now, a: i, s: "BTCUSDT", p: "1", q: "1", T: h.now, m: true } });
    expect(h.engine.trades("BTCUSDT").length).toBeLessThanOrEqual(5_000);
    expect(h.client.metrics().processing.count).toBe(10_000);
    h.client.stop();
  });
});
