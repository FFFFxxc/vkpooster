#!/usr/bin/env bash
set -euo pipefail

BASE_COMMIT="7350ea66e2bafaf1b5de2c97f099cf549ea12c5d"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/changes.diff"
TARGET_DIR="${1:?usage: ROLLBACK.sh TARGET_WORKTREE}"

cd "$TARGET_DIR"
git apply --reverse --check "$PATCH_FILE"
git apply --reverse "$PATCH_FILE"
printf 'ROLLBACK_OK base=%s target=%s restored=okcdn-rejected-and-version-4.6.0\n' "$BASE_COMMIT" "$TARGET_DIR"
