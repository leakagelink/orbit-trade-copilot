# Phase 4H.8 — Unverified assumptions
- The browser feed is display/paper data; a user can modify their own browser and therefore their own paper results. Paper results are never trusted by any server path.
- Binance may change stream routing (as it did: market vs public sockets); the client fails closed (not ready) when streams go silent.
- Queue-position and no-market-impact assumptions make paper fills optimistic for large size.
- Maintenance margin is generic, not account-bracket.
