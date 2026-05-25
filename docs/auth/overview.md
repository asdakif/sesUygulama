# Auth Overview

## Scope

This document describes the live authentication system in `sesUygulama` after the authentication overhaul phases.

Relevant code:

- [`server/auth-routes.js`](../../server/auth-routes.js)
- [`server/auth-middleware.js`](../../server/auth-middleware.js)
- [`server/auth/sessions.js`](../../server/auth/sessions.js)
- [`server/auth/tokens.js`](../../server/auth/tokens.js)
- [`server/auth/totp.js`](../../server/auth/totp.js)
- [`database.js`](../../database.js)

## Core model

The system uses:

- canonical usernames stored in SQLite
- `scrypt` password hashes
- short-lived signed access tokens
- rotating opaque refresh tokens
- mandatory TOTP-based 2FA
- audit logging for security-sensitive events

## Main login flow

1. `POST /api/auth/login`
2. Password is verified with a timing-safe fallback path for unknown usernames.
3. If the account has no enrolled TOTP, the server returns a `pending_token` with `requires: ["totp_enroll"]`.
4. If TOTP is already enabled, the server returns a `pending_token` with `requires: ["totp_verify"]`.
5. The client completes `/api/auth/2fa/enroll/confirm`, `/api/auth/2fa/verify`, or `/api/auth/2fa/recovery`.
6. On success, the server issues:
   - `access_token`
   - `refresh_token`
   - normalized `user` payload

## Token model

### Access token

- signed with `AUTH_SECRET`
- default TTL: `15` minutes
- contains:
  - `sub`
  - `ver`
  - `rol`
  - `iat`
  - `exp`
  - `jti`
  - `v`

The token is checked on every authenticated HTTP request and Socket.IO handshake.

### Refresh token

- opaque wire format: `<token_id>.<secret>`
- stored server-side as a hash
- rotated on every `/api/auth/refresh`
- family reuse detection revokes the entire family and bumps `accounts.token_version`

### Pending auth token

- used only during MFA enrollment/verification
- not accepted by normal auth middleware
- default TTL: `5` minutes

## Session invalidation

The server invalidates active sessions by:

- bumping `accounts.token_version`
- revoking refresh tokens in SQLite
- optionally revoking the current access token `jti`
- disconnecting active sockets for the affected username

This is used by:

- logout-all
- password change
- password reset
- admin disable
- admin TOTP reset
- refresh token reuse detection

## Legacy token cutover

Legacy schema v1 access tokens can be temporarily accepted through `LEGACY_AUTH_TOKEN_GRACE_UNTIL`.

- before the cutoff:
  - requests are accepted
  - HTTP responses include `X-Auth-Migrate: refresh`
  - audit event: `legacy_token_used`
- after the cutoff:
  - requests are rejected with `code: "legacy_token"`
  - audit event: `legacy_token_rejected`

If the env var is unset, legacy-token cutoff is not enforced.

## Rate limits

Auth-specific rate limiting currently includes:

- login throttling and lockout in [`server/auth/rate-limit.js`](../../server/auth/rate-limit.js)
- forgot-password per-email and per-IP buckets
- TOTP and recovery-code attempt buckets
- dedicated refresh limiter:
  - `AUTH_REFRESH_RATE_MAX`
  - `AUTH_REFRESH_RATE_WINDOW_MS`

## Main auth endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/change-display-name`
- `POST /api/auth/change-password`
- `POST /api/auth/change-email`
- `POST /api/auth/change-email/confirm`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:id`
- `POST /api/auth/sessions/logout-all`
- `POST /api/auth/account/delete`
- `POST /api/auth/account/restore`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/2fa/enroll`
- `POST /api/auth/2fa/enroll/confirm`
- `POST /api/auth/2fa/verify`
- `POST /api/auth/2fa/recovery`
- `POST /api/auth/2fa/regenerate-recovery`
- `POST /api/auth/2fa/reset`

## Storage

Important auth tables:

- `accounts`
- `refresh_tokens`
- `revoked_access_tokens`
- `password_reset_tokens`
- `totp_recovery_codes`
- `invites`
- `invite_redemptions`
- `security_audit_log`
- `login_attempts`

## Operational checks

Basic checks after deploy:

1. `GET /health` returns `200`.
2. A fresh login finishes MFA and returns both tokens.
3. `/api/auth/refresh` rotates successfully.
4. `/api/auth/me` works with the new access token.
5. Audit rows are being written for login and refresh activity.
