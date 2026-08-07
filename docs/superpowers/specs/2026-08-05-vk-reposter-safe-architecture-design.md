# VK Reposter Pro: safe architecture

Date: 2026-08-05

## Goal

Keep fast, non-blocking publication to several VK communities while removing the
behaviour most likely to trigger account-compromise protection.

## Safety boundary

- No VK cookies, `remixsid`, internal `web_token`, header spoofing, or cookie
  injection.
- No Kate Mobile/VFeed/vkhost OAuth impersonation.
- No automatic likes or multi-account boosting.
- User access tokens are optional, stored only in `chrome.storage.local`, and are
  never uploaded to the server.
- Community tokens are preferred for community-owned operations.
- The extension sends VK API calls strictly one at a time with a minimum delay.
- CAPTCHA, validation, rate-limit, flood-control, and suspicious-activity errors
  pause the queue instead of retrying aggressively.

## Components

### Browser extension

The browser remains the source of truth for publishing.

- A persistent local queue lets the user continue browsing and adding posts.
- A single serial worker publishes jobs in FIFO order.
- `wall.post` uses a community token when the chosen operation is supported.
- A repost that cannot be performed by a community token requires an explicitly
  configured local user token; there is no silent credential fallback.
- Native VK `publish_date` schedules wall posts without keeping the browser open.
- Once a post is created, a delayed comment job can be sent to the companion
  server using the target community token.

### Companion server

The server exists only for jobs that must run while the browser is closed,
primarily delayed comments.

- Every `/api/*` endpoint requires a bearer secret.
- Community tokens are encrypted with AES-256-GCM before storage.
- The server never returns a token or encrypted token fields.
- Jobs use caller-provided idempotency keys and atomic claims.
- Stale processing locks are recovered after a timeout.
- Protective VK errors pause a job; they are not hammered with retries.
- Legacy account-sync endpoints are intentionally absent.

## Credentials

| Operation | Preferred credential | Fallback |
| --- | --- | --- |
| Copy/text post | Target community token | Local user token, only when explicitly selected |
| Original VK repost | Local user token | None |
| Delayed community comment | Target community token | Local user token only while browser is open |
| Media re-upload | Local user token | Reuse existing public attachment IDs where possible |

Community tokens are scoped to a single target group. A token is never reused for
another group unless the user explicitly maps it there.

## Queue states

`queued -> processing -> completed`

Recoverable transport or server errors return the job to `queued` with bounded
backoff. VK protection errors move the job to `paused`. Invalid credentials or
unsupported operations move the job to `failed` with a user-visible explanation.
A stale `processing` job is changed back to `queued` on extension startup.

## Deployment

The server is a standalone Node.js service with MongoDB and a `render.yaml`
blueprint. Deployment requires three secrets:

- `MONGODB_URI`
- `API_SECRET`
- `TOKEN_ENCRYPTION_KEY` (32 random bytes encoded as base64)

The extension stores the matching API secret locally and sends it only to the
configured HTTPS server.

## Compatibility decisions

- `vk.com` and `vk.ru` page matching remains supported.
- VK API calls use `https://api.vk.com/method/...`.
- Existing local groups and queue data are migrated where possible.
- Cookie accounts and server-synced user accounts are not migrated.
- Auto-like controls are removed rather than hidden.

