# VK Reposter Pro safe rewrite plan

Date: 2026-08-05

## 1. Safety core

- Add Node tests for VK error classification, credential selection, attachment
  normalization, stale queue recovery, and serial scheduling.
- Implement a browser/CommonJS-compatible pure module.
- Integrate it into the service worker.

## 2. Extension authentication

- Remove cookie and declarative-request permissions.
- Remove Kate Mobile OAuth and cookie-account handlers.
- Remove account upload/download to the server.
- Add community-token mapping and an optional local-only user token.
- Add server URL and bearer-secret settings.

## 3. Publishing

- Convert parallel group batches to a single FIFO worker.
- Select credentials explicitly per target and operation.
- Reuse VK attachment IDs when community tokens cannot upload media.
- Keep native `publish_date`.
- Pause the worker on VK protection errors and show the reason.

## 4. Delayed comments

- Create delayed comment jobs after a successful immediate or scheduled post.
- Prefer the target community token.
- Use an idempotency key derived from the local queue job and post.
- Keep local execution as a browser-open fallback.

## 5. Server

- Create an Express/Mongoose application under `server/`.
- Add bearer authentication, request validation, size limits, and safe logs.
- Encrypt community tokens with AES-256-GCM.
- Add idempotent scheduled-comment endpoints and an atomic background worker.
- Add health/history endpoints without credential disclosure.
- Add Render blueprint, environment example, and deployment guide.

## 6. Cleanup and verification

- Remove auto-like/boost UI and alarms.
- Remove unreachable cookie and third-party OAuth code.
- Run unit tests, JS syntax checks, manifest validation, and secret scans.
- Verify a production-like server boot with invalid/missing configuration failing
  closed.
- Document the exact MongoDB and Render setup steps plus a cautious first-run
  smoke test for one test community.

