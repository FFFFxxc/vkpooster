#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
BASELINE="9524179ce981434880d0ca0026278eebe3f90eb3"

git -C "$TARGET" restore --source "$BASELINE" --staged --worktree -- .
git -C "$TARGET" clean -f -- \
  docs/superpowers/plans/2026-08-11-server-user-automation.md \
  docs/superpowers/specs/2026-08-11-server-user-automation-design.md \
  server/src/models/scheduled-post.js \
  server/src/post-service.js \
  server/src/post-validation.js \
  server/src/post-worker.js \
  server/test/post-service.test.js \
  server/test/post-validation.test.js \
  server/test/post-worker.test.js \
  tests/waiting-draft-core.test.js \
  waiting-draft-core.js

echo "ROLLBACK_OK baseline=$BASELINE target=$TARGET"
