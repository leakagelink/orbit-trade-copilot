#!/usr/bin/env bash
# Compares a LOCAL backup file with the recorded authoritative backup identity (docs/phase-4e/authoritative-backup.json).
# Read-only: computes size and SHA-256, reads nothing else and connects to nothing. Exit 0 = identical, 1 = different,
# 2 = refused input. Usage: scripts/db-export/check-backup-identity.sh /path/to/file.backup
set -euo pipefail
refuse(){ echo "REFUSED: $*" >&2; exit 2; }
[[ $# -eq 1 ]] || refuse "exactly one local file is required"
[[ "$1" =~ :// ]] && refuse "URLs are not accepted; download the file first and pass its local path"
[[ -f "$1" && -r "$1" ]] || refuse "'$1' is not a readable local file"
ROOT=$(cd "$(dirname "$0")/../.." && pwd); ID="$ROOT/docs/phase-4e/authoritative-backup.json"
WANT_SHA=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['sha256'])" "$ID")
WANT_SIZE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['sizeBytes'])" "$ID")
OLD_SHA=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['superseded']['sha256'])" "$ID")
GOT_SHA=$(sha256sum "$1" | cut -d' ' -f1); GOT_SIZE=$(stat -c %s "$1")
echo "file: $(basename "$1")  size: $GOT_SIZE  sha256: $GOT_SHA"
if [[ "$GOT_SHA" == "$WANT_SHA" && "$GOT_SIZE" == "$WANT_SIZE" ]]; then echo "MATCH: authoritative 13 Nov 2026 backup"; exit 0; fi
if [[ "$GOT_SHA" == "$OLD_SHA" ]]; then echo "DIFFERENT: this is the superseded 12 Nov 2026 export (taken before migration 0039)"; exit 1; fi
if head -c 2 "$1" | grep -q "PK"; then echo "DIFFERENT: this is a ZIP container; its checksum never equals the backup inside it — extract the .backup and check that file"; exit 1; fi
echo "DIFFERENT: not the authoritative backup (expected $WANT_SIZE bytes, sha256 $WANT_SHA)"; exit 1
