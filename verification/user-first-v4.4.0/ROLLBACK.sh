#!/usr/bin/env bash
set -eu

TARGET="${1:?usage: ROLLBACK.sh /absolute/path/to/repository-copy}"
BASELINE_COMMIT="6a26065b71b996546accbeccbd116fef05053a28"

git -C "$TARGET" checkout "$BASELINE_COMMIT" -- \
  README.md \
  background.js \
  manifest.json \
  package.json \
  popup-auth.js \
  popup.html \
  safety-core.js \
  scheduled.js \
  tests/manifest-security.test.js \
  tests/photo-copy-contract.test.js \
  tests/popup-account.test.js \
  tests/safety-core.test.js \
  tests/scheduled-results-ui.test.js

rm -f "$TARGET/tests/user-first-contract.test.js"
printf '%s\n' "ROLLBACK_OK baseline=$BASELINE_COMMIT target=$TARGET"
