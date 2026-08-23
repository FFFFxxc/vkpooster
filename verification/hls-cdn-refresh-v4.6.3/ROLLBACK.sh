#!/usr/bin/env bash
set -euo pipefail
BASE_COMMIT="a19cc4c77e1a130ee504c23eedd2380b2e025623"
git checkout "$BASE_COMMIT" -- \
  README.md content.js injection.js manifest.json package.json popup.html \
  tests/clip-download-contract.test.js tests/manifest-security.test.js
printf 'ROLLBACK_RESULT=restored_to_%s\n' "$BASE_COMMIT"
