#!/usr/bin/env bash
set -eu

TARGET="${1:?usage: ROLLBACK.sh /absolute/path/to/repository-copy}"
BASELINE_COMMIT="7748ba3"

git -C "$TARGET" checkout "$BASELINE_COMMIT" -- \
  README.md \
  manifest.json \
  package.json \
  popup-auth.js \
  popup.html \
  tests/manifest-security.test.js

git -C "$TARGET" clean -f -- backup-core.js tests/backup-core.test.js
printf '%s\n' "ROLLBACK_OK baseline=$BASELINE_COMMIT target=$TARGET"
