#!/usr/bin/env bash
set -euo pipefail

BASE_COMMIT="f4cf59aa490b5a2fead98e3e6faee0ae2a9bf9f2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/changes.diff"
TARGET_DIR="${1:?usage: ROLLBACK.sh TARGET_WORKTREE}"

cd "$TARGET_DIR"
git apply --reverse --check "$PATCH_FILE"
git apply --reverse "$PATCH_FILE"
printf 'ROLLBACK_OK base=%s target=%s restored=direct-m3u8-text-download-version-4.6.1\n' "$BASE_COMMIT" "$TARGET_DIR"
