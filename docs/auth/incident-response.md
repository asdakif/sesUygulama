# Incident Response

## Purpose

This playbook covers the most likely auth incidents for this repo.

## 1. Leaked refresh token

Symptoms:

- `refresh_reuse_detected` appears in audit logs
- user reports unexpected logout
- repeated refresh failures from a single account

Immediate actions:

1. identify the affected username from `security_audit_log`
2. revoke all sessions for that user
3. ask the user to log in again and rotate their password
4. review recent admin and account actions

Expected system behavior:

- reuse detection revokes the whole refresh family
- `accounts.token_version` is bumped
- active sockets are disconnected

## 2. Compromised account

Symptoms:

- user reports actions they did not perform
- suspicious audit events
- strange active sessions or email changes

Immediate actions:

1. admin runs logout-all for the user
2. if needed, disable the account temporarily
3. reset 2FA only after confirming identity
4. set a new password through the reset flow or by supervised recovery
5. review:
   - email change events
   - password reset events
   - invite creation or admin changes

## 3. Lost 2FA device

Preferred recovery:

1. user logs in with a recovery code
2. user regenerates recovery codes
3. if device is permanently lost, re-enroll TOTP

If recovery codes are also lost:

1. admin verifies identity out of band
2. admin calls `POST /api/auth/2fa/reset`
3. user logs in again and completes fresh enrollment

Never disable MFA globally as a shortcut.

## 4. Mass lockout false positive

Symptoms:

- many users suddenly get `account_locked`
- login_fail and lockout_triggered spike together

Immediate actions:

1. confirm whether the issue is abusive traffic or a bad client loop
2. inspect `login_attempts` and recent deploy changes
3. if the lockout is false-positive, clear the affected buckets or wait for expiry
4. reduce or disable the bad traffic source

If the issue is caused by stale legacy clients:

- extend `LEGACY_AUTH_TOKEN_GRACE_UNTIL`
- communicate a forced update window

## 5. Email delivery outage

Symptoms:

- no verification or reset emails arrive
- provider dashboards show bounces or auth failures

Immediate actions:

1. confirm `EMAIL_PROVIDER` and credentials
2. verify `EMAIL_FROM`
3. verify `PUBLIC_APP_URL`
4. inspect provider-specific logs

User impact:

- new registrations cannot complete email trust steps
- password recovery is blocked

## 6. Admin account loss

If all admins lose access:

1. use `BOOTSTRAP_ADMIN_USERNAME` on a known-good account
2. restart the service if needed
3. confirm the promotion in the audit log
4. create a backup admin immediately

## Log sources to check

- `security_audit_log`
- Railway deploy logs
- Railway runtime logs
- email provider logs
- client reports from affected users

## Minimum incident notes to record

For every auth incident, capture:

- start time in UTC
- affected usernames
- triggering event type
- mitigation steps taken
- whether sessions were revoked
- whether passwords or 2FA were reset
- final recovery time
