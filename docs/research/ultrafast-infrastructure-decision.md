# Seconds-level scalping: market-data infrastructure decision (Phase 4A)

**Decision document only. Nothing was deployed, purchased or connected.** Prices were checked on 2026-11-12 from the
linked vendor pages and can change; "verified" = read on the vendor's page, "estimated" = derived or third-party.

## Why this is needed
The app runs on request-scoped Cloudflare Workers. It cannot hold a WebSocket open between requests, so it cannot keep
a live order book. Seconds-level signals (`src/lib/scalp-microstructure.ts`) therefore run offline only, and fail
closed (NO TRADE) on stale, slow or missing data. Separately, the one-day markout study found the trade-flow edge was
0.1–0.3 bps against ~12 bps taker round-trip cost — infrastructure alone would not make it viable.

## Components (same for every hosting option)
| Component | Design |
|---|---|
| Persistent WebSocket | Binance USD-M streams `<sym>@depth@100ms`, `@aggTrade`, `@bookTicker`, `@markPrice`. Connections end after 24 h; server pings every 3 min, no pong within 10 min disconnects; max 10 incoming messages/s per connection. Planned reconnect before 24 h on an overlapping second socket. |
| Order book recorder | Binance local-book procedure: buffer diffs → REST snapshot (`/fapi/v1/depth`, weight 2/5/10/20 for ≤50/100/500/1000 levels) → drop updates with `u` < `lastUpdateId` → first update must bridge → every next update's `pu` must equal the previous `u`. Any gap invalidates the book and forces a resync; trading consumers see "book invalid". |
| Aggregated trade recorder | `@aggTrade`; continuity on aggregate trade id `a`; gaps backfilled from REST `/fapi/v1/aggTrades` by id. |
| Feed-age monitoring | Per stream: last receive time, last exchange event time `E`; `age = now − last receive`. Consumers must treat age above a threshold (e.g. 500 ms) as missing. |
| Exchange-to-receipt latency | Record `receive − E` and `receive − T` per message; host clock disciplined by chrony/NTP with measured offset and uncertainty stored alongside. Without clock-offset evidence the number is not pure network latency. |
| Retention | Raw compressed hourly files (ndjson.zst or parquet) in object storage; Postgres keeps only health metrics and derived features. |
| Recovery | Reconnect with jittered backoff; resubscribe; snapshot-resync the book; backfill trades by id; mark the outage window so research and paper replay exclude it. |

## Hosting options and monthly cost
| Option | Monthly cost | Notes |
|---|---:|---|
| A. Cloudflare Durable Object holding an outbound socket | **≥ $5** (Workers Paid, verified) + duration: 400,000 GB-s included, then $12.50 per million GB-s; requests 1 M included, then $0.15/M (verified). A socket kept open all month is ~2.6 M s; at 128 MB that is ~330,000 GB-s, near the included amount — **estimated $5–10**, but only if hibernation does not apply and billing behaves as estimated (**unverified** for outbound sockets). | Whether Lovable hosting lets this project add Durable Object bindings is **unverified**. Placement is not user-selectable to Tokyo, so latency is less predictable. |
| B. Small VPS in Tokyo (AWS Lightsail / Vultr) | **$5–20** (Lightsail $5 and $7 plans verified; Tokyo availability to confirm at purchase; Vultr $5 Tokyo from a third-party comparison — estimated) | Closest practical placement to Binance (AWS Tokyo is a plausible, not official, location). Full control of chrony, process supervision and disk. |
| C. Fly.io / Railway always-on machine | **$3–20+** (Fly lists $2.19/month for 256 MB in its base region; Tokyo `nrt` pricing not verified; Railway Tokyo unverified) | Simple deploys; region pricing must be confirmed. |

### Storage
* Measured public archive sizes for 2026-11-10: BTCUSDT + ETHUSDT aggTrades ZIPs = 40.3 MB/day (≈ 1.21 GB/month
  compressed); bookDepth ZIPs = 1.16 MB/day (aggregated depth, not full L2). Raw `@depth@100ms` volume must be
  measured — up to 10 messages/s/symbol (≈ 1.73 M messages/day for two symbols) before compression.
* Cloudflare R2: $0.015/GB-month, first 10 GB-month free (verified) → aggTrades fit the free tier for months; full
  depth likely 1–5 GB/month compressed (estimated) → roughly $0–1/month.
* Lovable Cloud database disk beyond the included amount is billed (Supabase gp3 $0.125/GB-month, verified); raw feeds
  should not go there.

## Recommendation
Do **not** build it yet: the measured edge is far below costs. If the owner still wants live data for research, the
lowest-risk option is **B (Tokyo VPS, ~$5–20/month) + R2 archives (~$0–1/month)**, exposing only health metrics and
derived features to the app through an authenticated, read-only endpoint. Option A should only be considered after
confirming Lovable supports Durable Object bindings and measuring outbound-socket billing. Any option is new paid
infrastructure and requires explicit approval.

## Sources
* Binance USD-M WebSocket market streams and local order book: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams
* Binance depth snapshot weight: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/websocket-api/Order-Book
* Durable Objects pricing / limits: https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/platform/limits/
* Workers limits: https://developers.cloudflare.com/workers/platform/limits/
* R2 pricing: https://developers.cloudflare.com/r2/pricing/
* Supabase disk: https://supabase.com/docs/guides/platform/manage-your-usage/disk-size
* Lightsail pricing: https://aws.amazon.com/lightsail/pricing/ · Vultr Tokyo comparison: https://vpscast.com/vps/tokyo · Fly pricing: https://fly.io/pricing/
* Binance public data archive: https://data.binance.vision/
