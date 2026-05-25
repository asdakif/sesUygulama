# Admin Bootstrap

## Purpose

This document explains how the first admin is established and how admins should manage auth-sensitive operations.

Code references:

- [`server/admin-bootstrap.js`](../../server/admin-bootstrap.js)
- [`server/auth-routes.js`](../../server/auth-routes.js)

## Bootstrap rules

On startup the server applies the following rules:

1. If `BOOTSTRAP_ADMIN_USERNAME` is set and that user exists, ensure the user has role `admin`.
2. Otherwise, if no admin exists and at least one account exists, promote the earliest account by `created_at`.
3. Otherwise, do nothing.

Every automatic promotion is written to `security_audit_log`.

## Recommended production env

```env
BOOTSTRAP_ADMIN_USERNAME=your_admin_username
```

This avoids ambiguity when multiple accounts already exist.

## First-admin checklist

After first deploy:

1. log in as the bootstrap admin
2. complete the email-code verification step
3. verify `/admin` loads
4. create at least one invite
5. create a second backup admin account
6. verify both admins receive email login codes successfully

## Core admin auth actions

Current admin routes include:

- `GET /api/admin/users`
- `POST /api/admin/users/:username/disable`
- `POST /api/admin/users/:username/enable`
- `POST /api/admin/users/:username/role`
- `POST /api/admin/users/:username/logout-all`
- `DELETE /api/admin/users/:username`
- `POST /api/admin/users/:username/email-set`
- `GET /api/admin/invites`
- `POST /api/admin/invites`
- `DELETE /api/admin/invites/:id`
- `GET /api/admin/audit-log`

## Invite operations

Preferred onboarding flow:

1. admin creates an invite
2. admin shares the raw invite code once
3. user registers with invite + email + password
4. user confirms the login code sent to email immediately

Keep `LEGACY_INVITE_ENABLED=false` once per-user invites are fully adopted.

## Lost-admin scenario

If the only admin loses access:

1. use `BOOTSTRAP_ADMIN_USERNAME` on restart if another known-good account exists
2. if no admin account exists anymore, the first surviving account will be promoted automatically
3. confirm the promotion in the audit log before using the account operationally

## Hardening tips

- keep at least two admin accounts
- never share admin credentials
- keep admin email addresses verified and monitored
- periodically review `security_audit_log` for admin actions
