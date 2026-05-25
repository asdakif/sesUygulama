# Auth Migration Runbook

## Purpose

This runbook covers auth-related deploys and cutovers, especially when enabling new token or MFA behavior.

## Pre-deploy checklist

Required env:

- `AUTH_SECRET`
- `PUBLIC_APP_URL`
- `EMAIL_PROVIDER`
- `EMAIL_FROM`

If using Resend:

- `RESEND_API_KEY`

If using SMTP:

- `SMTP_URL`

Optional but recommended:

- `BOOTSTRAP_ADMIN_USERNAME`
- `REGISTRATION_INVITE`
- `LEGACY_INVITE_ENABLED`
- `LEGACY_AUTH_TOKEN_GRACE_UNTIL`

## Before shipping a breaking auth change

1. confirm `npm run check` passes locally
2. confirm the database migrations apply cleanly on a copy of production data if possible
3. ensure at least one admin account is reachable
4. ensure email delivery works in the target environment
5. announce the change to users if MFA or login behavior changes

## Legacy token cutover

This repo supports an explicit grace cutoff for old schema v1 access tokens.

Example:

```env
LEGACY_AUTH_TOKEN_GRACE_UNTIL=2026-06-08T21:00:00.000Z
```

Behavior:

- before that time:
  - legacy tokens still work
  - HTTP responses include `X-Auth-Migrate: refresh`
- after that time:
  - legacy tokens fail with `code=legacy_token`

Recommended rollout:

1. deploy new auth stack with the cutoff unset
2. confirm current clients are rotating onto refresh-based sessions
3. set `LEGACY_AUTH_TOKEN_GRACE_UNTIL` to a concrete future UTC timestamp
4. announce the deadline
5. monitor `legacy_token_used` audit events
6. after the deadline, confirm `legacy_token_rejected` appears only for stale clients

## Invite cutover

Recommended invite rollout:

1. keep `LEGACY_INVITE_ENABLED=true`
2. create real per-user invites through admin tools
3. monitor `legacy_invite_used`
4. once no one uses the shared invite anymore, set:

```env
LEGACY_INVITE_ENABLED=false
```

## Post-deploy verification

Immediately after deploy:

1. `GET /health` returns `200`
2. register a test user
3. complete email-code verification
4. refresh the session once
5. verify `/api/auth/me`
6. request a password reset email
7. verify admin panel access

## Rollback guidance

If an auth deploy goes bad:

1. stop changing env vars first
2. roll back the app code
3. keep the migrated DB unless the migration itself is corrupt
4. if users are mass-locked-out, temporarily extend or remove `LEGACY_AUTH_TOKEN_GRACE_UNTIL`
5. if email is failing, switch `EMAIL_PROVIDER=noop` only in a non-production emergency and announce that resets are paused

Do not delete auth tables during rollback. The system expects refresh, audit, invite, and email-code state to remain intact.
