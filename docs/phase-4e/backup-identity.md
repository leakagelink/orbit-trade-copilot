# Backup SHA-256 discrepancy — investigation and authoritative identity (13 Nov 2026)

Read-only. Both stored export objects were downloaded to a temporary folder (mode 0444), fingerprinted and deleted; the
stored objects were not modified. No database connection was made for this step.

| | 12 Nov export | 13 Nov export |
|---|---|---|
| Storage object | `database_export_12_11_26/orbit-trade-copilot_261112.backup` | `database_export_13_11_26/orbit-trade-copilot_261113.backup` |
| Stored at (UTC) | 2026-11-12 06:54:17 | 2026-11-13 09:20:40 |
| Archive created (UTC) | 2026-11-12 06:52:44 | 2026-11-13 09:19:04 |
| Size | 2,092,954 bytes | 2,525,322 bytes |
| SHA-256 | `7af876652ee97596afea1736f11f170cc23d11c474c0927a077e776da3276634` | `448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5` |
| MD5 | `8048b030dcd13fa30c5ee321d11336d2` | `5db5e5d9a1d90cf799631f3e0b206bf7` |
| Storage eTag | `f26af7704ac429bf917f402b0d0864fb-1` | `a10797fb0a42e8e28ffa8b7fc8e2b242-1` |
| eTag recomputed from the file (MD5 of the MD5, 1 part) | matches | matches |
| TOC entries | 1,211 | 1,256 |
| Latest applied migration | before 0039 | `0039_futures_pass_certification_and_autopilot_fencing` |

## Findings

1. **The two checksums belong to two different exports, not to one corrupted file.** The 12 Nov hash `7af87665…` was
   recorded in the Phase 1 / Phase 3 restore reports; the 13 Nov hash `448bb1c2…` in Phase 4E. Both re-computed today
   exactly as recorded, and each matches the storage server's own eTag, so neither file changed since it was stored.
2. **The ZIP named in the Phase 4E brief (`bucket-database_export_13_11_26-files.zip`) was never received.** A ZIP is a
   container: its SHA-256 can never equal the `.backup` inside it. Demonstrated: zipping the 13 Nov backup produced a
   2,525,486-byte file with SHA-256 `f373810f…f30e53`, while the backup inside is still `448bb1c2…`. Any checksum taken of
   the ZIP must be compared after extraction.
3. No third export object exists in storage.

## Authoritative identity (preserved)

`orbit-trade-copilot_261113.backup`, 2,525,322 bytes, SHA-256
`448bb1c2f5631321565a292b7b8b4aef7a38a5ab5b978449102633818fc0b6a5` — recorded in `authoritative-backup.sha256`
(sha256sum format) and `authoritative-backup.json` (with size, MD5, eTag and the superseded 12 Nov identity), pinned by
`src/test/phase4f-isolation.test.ts`. `scripts/db-export/check-backup-identity.sh <file>` reports MATCH, the superseded
export, or a ZIP container. On Windows PowerShell the owner can check an extracted copy with:
`Get-FileHash .\orbit-trade-copilot_261113.backup -Algorithm SHA256` (expected hash above, upper-case in PowerShell).

This identifies the file used for local practice restores; it is not proof of Lovable Cloud restore readiness.
