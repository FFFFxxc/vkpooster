#!/usr/bin/env bash
set -eu

TARGET="${1:?usage: ROLLBACK.sh /absolute/path/to/repository-copy}"
BASELINE_COMMIT="278d6e4"

git -C "$TARGET" checkout "$BASELINE_COMMIT" -- \
  README.md \
  background.js \
  content-shadow-dom.js \
  content.js \
  manifest.json \
  package.json \
  popup.html \
  scheduled-fixes.css \
  scheduled.js \
  tests/manifest-security.test.js \
  tests/scheduled-results-ui.test.js

printf '%s\n' "ROLLBACK_OK baseline=$BASELINE_COMMIT target=$TARGET"
