# Draft migration dependency and rollback diagram — Phase 4H.2 (13 Nov 2026)

**No change from Phase 4H.1.** Phase 4H.2 needed no database change: the token lifecycle is application code, and
the security regression tests passed against 0054 as drafted. No successor draft (0055) exists. None of these drafts
is applied; the hosted migration journal ends at 0039 (last read-only check: Phase 4H.1, 13 Nov 2026; not re-read).

```text
 hosted, applied            drafts (docs/proposed-migrations/, NOT applied, byte-identical to Phase 4H.1)
 ───────────────            ──────────────────────────────────────────────────────────────────────────────
 0000 … 0039  ──►  0049 ledger v3 ──► 0050 worker gateway ──► 0051 event completeness ──►
             ──►  0052 entry completeness ──► 0053 worker identity ──► 0054 identity lifecycle

 Apply order    : 0049 → 0050 → 0051 → 0052 → 0053 → 0054     (each in ONE transaction)
 Rollback order : 0054 → 0053 → 0052 → 0051 → 0050 → 0049     (each in ONE transaction, no CASCADE)

 application code on top (not migrations; all DISABLED):
   futures-paper-worker-hosted.ts ── six logical calls (0050 names)
   futures-paper-worker-identity.ts ── maps them to the six 0053/0054 fpw_id_* wrappers
   worker-auth-session.ts (4H.2) ── one bounded sign-in/sign-out per tick
   futures-paper-worker-identity.server.ts (4H.2) ── fetch transports + flags; imported by nothing
```

| Draft | SHA-256 (draft) | SHA-256 (rollback) |
|---|---|---|
| 0049 | `fe4dd56c…abcd35` | `e5931321…1fb5fb` |
| 0050 | `40c2fdbf…a4c0fa` | `93197b8c…aa346b` |
| 0051 | `58828556…80b788` | `41d1aa85…0d94cf` |
| 0052 | `e6ed1a01…ef40d9` | `562128f7…ad84d3` |
| 0053 | `d4360911…48d2bf` | `11fec84b…1923d2` |
| 0054 | `391beac6…c47177` | `4e78cebe…d34569` |

Full hashes are pinned in `src/test/phase4h2-isolation.test.ts`. Dependency and rollback-blocking rules are unchanged
from `docs/phase-4h1/migration-chain-diagram.md`.
