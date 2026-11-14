# Phase 4H.8 — Market-data verification

Scope: Binance USD-M public market data for BTCUSDT and ETHUSDT. No API key, signature or account endpoint is used anywhere in this path.

## What was built
| Item | Module | Notes |
|---|---|---|
| Message parsers (aggTrade, depthUpdate, bookTicker, markPriceUpdate, kline 1m/5m) | `src/lib/live-feed.ts` `parseMessage` | Strict field checks; malformed messages are counted and dropped, never guessed. |
| Local order book | `FeedEngine.applySnapshot` / depth handling | Buffer diffs → REST snapshot → first diff must bridge `lastUpdateId` → every later diff must have `pu` = previous `u`; any break invalidates the book and triggers resync. |
| Trade-ID continuity | `FeedEngine` | aggTrade ids must be consecutive; duplicates ignored; gaps recorded and mark the trade-flow window incomplete for 120 s. |
| Candle continuity | `mergeKlines`, kline handling | Closed 1m/5m candles only; missing intervals reported as gaps. |
| Stale-feed detection | `health()` | Per-stream age limits; health is `ready` only when book synced, all streams fresh and no gap. |
| Clock drift | `setServerTime` | Offset from `/fapi/v1/time` with round-trip midpoint; drift flagged above the limit. |
| Rate limits | `RestGovernor` | Tracks `x-mbx-used-weight-1m`, honours `Retry-After`, backs off on 418/429. |
| Reconnecting client | `src/lib/live-feed-client.ts` | Two sockets (market + public), capped exponential back-off with jitter (250 ms–30 s), silent-socket watchdog, resubscribe, book invalidation on disconnect. |
| Monitoring | `src/lib/live-monitor.ts` | Bounded event ring with correlation IDs; credential-looking values redacted. |

## Facts found against the real service (14 Nov 2026)
- Market streams (aggTrade, markPrice, kline) are delivered only on `wss://fstream.binance.com/market/stream`; depth and bookTicker only on `/public/stream`. The legacy combined `/stream` accepted the connection but sent nothing — this is why the client opens two sockets.
- REST host `https://fapi.binance.com` public GETs worked from the sandbox and, with CORS, from a real Chromium browser on the app's origin.
- `exchangeInfo`: BTCUSDT min notional 50 USDT, step 0.001, tick 0.1; ETHUSDT min notional 20 USDT, step 0.001, tick 0.01. `maintMarginPercent` is a generic 2.5 %, **not** the account's leverage bracket — paper liquidation prices are therefore approximate.

## Evidence
| Evidence | Kind | Result |
|---|---|---|
| `evidence/live-feed-run-100s.json` | **REAL** live public data, 100 s, both symbols | 89,049 messages, 89,047 accepted, 0 malformed. Both books SYNCED. Clock offset 2 ms, RTT 239 ms. Processing p50 0 ms, p95 0 ms, max 5 ms. |
| Same run, forced public-socket disconnect | REAL data, induced fault | Both books invalidated, one resync each, back to SYNCED. |
| Same run, forced market-socket disconnect | REAL data, induced fault | One trade-ID gap per symbol detected; signals correctly became INSUFFICIENT_DATA instead of using incomplete flow. |
| `evidence/browser-public-feed.txt` | REAL, Chromium on localhost | REST depth 200 OK; in 8 s: 130 market and 3,175 public messages across all five stream types. |
| `src/test/fixtures/binance-usdm/recorded-feed.json` | RECORDED real data (~30 s, 2,042 messages; bookTicker thinned 25×) | Replay: both books SYNCED, no gaps, local best bid/ask equals last bookTicker exactly; 5 stale depth events correctly dropped. |
| `src/test/phase4h8-feed.test.ts` | Recorded replay + synthetic faults | 27/27 PASS |
| `src/test/phase4h8-client.test.ts` | Fake socket/clock (deterministic) | 9/9 PASS — back-off sequence 500→30,000 ms, resubscribe, watchdog, stop(), 429 handling, listener faults, bounded memory over 10,000 messages. |

## Result: PASS (public data path). Limitations
- Measured in this sandbox and one desktop browser only; mobile networks, long sessions (hours) and Binance maintenance windows are NOT VERIFIED.
- The feed runs in the user's browser tab; it stops when the tab is closed or throttled in the background. There is no server-side feed (persistent sockets are not available in the current hosting).
