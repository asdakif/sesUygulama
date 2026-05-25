# Email Setup

## Purpose

This project uses email for:

- email verification
- email change confirmation
- password reset

Implementation lives in [`server/auth/email.js`](../../server/auth/email.js).

## Supported providers

### `resend`

Recommended hosted option.

Required env:

- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `PUBLIC_APP_URL`

### `smtp`

SMTP is supported through `nodemailer`.

Required env:

- `EMAIL_PROVIDER=smtp`
- `SMTP_URL`
- `EMAIL_FROM`
- `PUBLIC_APP_URL`

Note: if SMTP is enabled in production, ensure the `nodemailer` dependency is installed and included in the deploy artifact.

### `noop`

Development and test mode.

Required env:

- `EMAIL_PROVIDER=noop`
- optionally `EMAIL_ALLOW_NOOP=true`

This does not deliver real email. It stores rendered messages in-process for tests and local inspection.

## Required shared env vars

These are required for real email delivery regardless of provider:

- `AUTH_SECRET`
- `EMAIL_FROM`
- `PUBLIC_APP_URL`

`PUBLIC_APP_URL` must match the URL users actually open, for example:

- `https://locast.app`

## Example env sets

### Resend

```env
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxx
EMAIL_FROM=Locast <noreply@locast.app>
PUBLIC_APP_URL=https://locast.app
```

### SMTP

```env
EMAIL_PROVIDER=smtp
SMTP_URL=smtps://username:password@mail.example.com:465
EMAIL_FROM=Locast <noreply@locast.app>
PUBLIC_APP_URL=https://locast.app
```

## Verification flow

When a user registers:

1. the account is created
2. the user completes MFA
3. a verification token is generated
4. an email verification link is sent
5. the client opens `/confirm-email?token=...`
6. the server verifies the token and marks `email_verified_at`

## Password reset flow

When a user requests a reset:

1. `POST /api/auth/forgot-password` always returns `204`
2. if the email belongs to a verified account, a reset token is created
3. the email contains a link to `/reset-password?token=<id>.<secret>`
4. `POST /api/auth/reset-password` consumes the token once
5. the password hash is updated
6. active sessions are revoked

## Validation checklist

After configuring email:

1. register a new user with a real mailbox
2. confirm the verification email arrives
3. click the verification link
4. request a password reset
5. verify the reset email arrives
6. complete the reset and confirm old sessions are dropped

## Failure modes

Common setup problems:

- wrong `PUBLIC_APP_URL` causes broken links
- missing `EMAIL_FROM` causes provider rejection
- `EMAIL_PROVIDER=smtp` without mail server access causes timeouts
- `noop` accidentally left on in production means no real email is sent

## Recommended production choice

Use `resend` unless you already operate a reliable SMTP provider. It is simpler to debug and has fewer moving parts for this repo.
