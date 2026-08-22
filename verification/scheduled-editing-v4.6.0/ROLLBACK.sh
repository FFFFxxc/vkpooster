#!/usr/bin/env bash
set -euo pipefail

BASE_COMMIT="85c19d8a63963488951cf00ca40a46c8575a23f0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="${2:-${SCRIPT_DIR}/changes.diff}"
TARGET_DIR="${1:-$(pwd)}"

cd "$TARGET_DIR"
git apply --reverse --check "$PATCH_FILE"
git apply --reverse "$PATCH_FILE"

printf 'ROLLBACK_OK base=%s target=%s\n' "$BASE_COMMIT" "$TARGET_DIR"
