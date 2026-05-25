# Authentication Overhaul — Design Spec

- **Date:** 2026-05-24
- **Status:** Draft, awaiting user review
- **Scope:** Full rebuild of `server/auth.js` + `server/auth-middleware.js` + the auth surface exposed by `server.js`, the SQLite schema in `database.js`, and the client login/session code in `public/app.js` / `public/index.html`.
- **Out of scope:** Channel permissions, message-level ACLs, end-to-end encryption of voice/chat, OAuth/SSO/social login, SMS-based 2FA, hardware-key (WebAuthn/Passkey) 2FA.

This spec replaces the current auth system. It is **broken into seven phases that ship independently**. Each phase is shippable on its own and leaves the system in a working state.

---

## 1. Background

### 1.1 What exists today

| Layer | File | Behavior |
|-------|------|----------|
| Hashing | `server/auth.js` | Node `crypto.scryptSync` with 16-byte salt, 64-byte hash, stored as `scrypt$<salt>$<hash>` (no parameter metadata) |
| Tokens | `server/auth.js` | Custom JWT-like: `base64url(json).base64url(hmac-sha256)`, claims `{ sub, iat, exp, jti, v:1 }`, default TTL **30 days** |
| Middleware | `server/auth-middleware.js` | `requireAuth` (HTTP Bearer) and Socket.io handshake middleware; both call `resolveAuthSession` which checks `revoked_tokens` + `accounts` existence |
| Storage | `database.js` | `accounts(username, password_hash, created_at, last_login_at)`, `revoked_tokens(token_id, revoked_at, expires_at)` |
| Endpoints | `server.js:110-177` | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` |
| Gating | `server/config.js` | `REGISTRATION_INVITE` (single shared code), `AUTH_SECRET` (both fall back to `PASSWORD`) |
| Client | `public/app.js` | Token in `localStorage` (`sesappAuthToken`), restored on boot via `/api/auth/me`, cleared on 401 |
| Rate limit | `server.js:75-83` | Generic `express-rate-limit` 100 req / 15 min on `/api/*` |

### 1.2 Security findings from the audit

| # | Sev | Issue |
|---|-----|-------|
| 1 | **HIGH** | Login timing oracle enables username enumeration (scrypt skipped when account missing). |
| 2 | **HIGH** | No brute-force protection on login (no per-username throttle, no lockout). |
| 3 | **HIGH** | Token revocation not enforced on already-connected sockets. |
| 4 | **HIGH** | `token_version` claim exists but is never checked → no "log out everywhere" lever. |
| 5 | **MED** | `AUTH_SECRET` falls back to `PASSWORD`; HMAC key can be a weak human-chosen string. |
| 6 | **MED** | 30-day bearer tokens; no rotation, no device binding; leaked token usable for a month. |
| 7 | **MED** | `revoked_tokens` table grows forever (prune statement exists, never invoked). |
| 8 | **MED** | Password floor 6 chars, no breach / dictionary check. |
| 9 | **MED** | Username PK is case-sensitive, no character allowlist (lookalike / RTL / zero-width). |
| 10 | **MED** | Scrypt hash has no parameter metadata; can't migrate to higher cost without rehash. |
| 11 | **MED** | Token payload is plaintext base64url (username visible). Document, don't carry secrets. |
| 12 | **LOW** | Registration 409 leaks username existence. |
| 13 | **LOW** | Invite code comparison is non-constant-time. |
| 14 | **LOW** | No security audit log (`failed_login`, `lockout`, `password_change`, etc.). |
| 15 | **LOW** | No CSRF token plumbing (currently OK because we use Authorization-header bearer). |
| 16 | **LOW** | `helmet` CSP includes `'unsafe-inline'` in `styleSrc` → wider XSS blast radius. |

Phase 1 fixes 1, 2, 4, 7, 8, 9, 10, 12, 13, 14. Phase 2 fixes 3, 6. Item 11 stays (documented constraint). Items 5, 15, 16 are addressed in Phase 0 and as ongoing hygiene.

### 1.3 Decisions locked by the user

| Topic | Choice | Implication |
|-------|--------|-------------|
| Password reset channel | **Email-based** | Requires email provider integration (Phase 0/4) and an `email` column on accounts. |
| Token strategy | **Access + refresh split** | 15-min access token, 30-day rotating refresh, reuse detection. |
| 2FA | **Mandatory for everyone** (TOTP) | Login becomes a two-step flow; account is unusable until TOTP is enrolled. Recovery codes are required. |

---

## 2. High-level architecture after overhaul

### 2.1 Module boundaries

```
server/auth/
  index.js              ← public API (current server/auth.js, re-exported)
  hashing.js            ← scrypt with versioned params
  tokens.js             ← access + refresh token issue/verify
  validators.js         ← username, password, email, totp-code validation
  email.js              ← email provider abstraction (Resend default, SMTP fallback)
  totp.js               ← TOTP secret generation, code verification, recovery codes
  rate-limit.js         ← per-username + per-IP login throttle, lockout state
  audit.js              ← security_audit_log sink
server/auth-middleware.js ← HTTP + Socket.io middleware (unchanged surface, new internals)
server/auth-routes.js   ← all /api/auth/* and /api/admin/* HTTP route definitions, mounted by server.js
```

Goal: `server.js` stops being a 1000-line god file for auth. It mounts `auth-routes` and is otherwise unaware of auth internals.

### 2.2 Data model after Phase 5

```
accounts(
  username TEXT PRIMARY KEY,           -- lowercase, [a-z0-9_]{2,20}
  display_name TEXT,                   -- preserved-case version for UI
  password_hash TEXT NOT NULL,         -- scrypt$N=...,r=...,p=...$salt$hash
  email TEXT,                          -- required for new accounts (Phase 4)
  email_verified_at INTEGER,
  email_pending TEXT,                  -- new email awaiting verification
  email_pending_token_hash TEXT,
  email_pending_expires_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  disabled_at INTEGER,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  totp_secret TEXT,                    -- base32; null until enrolled
  totp_enabled_at INTEGER,             -- null until verified
  pending_delete_at INTEGER,           -- soft-delete grace
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
)

refresh_tokens(
  token_id TEXT PRIMARY KEY,           -- uuid v4
  token_hash TEXT NOT NULL,            -- sha-256 of the opaque secret
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  family_id TEXT NOT NULL,             -- shared across rotations of the same login
  account_token_version_at_issue INTEGER NOT NULL,  -- snapshot for stale detection on refresh
  device_label TEXT,                   -- "Chrome on macOS" derived from UA
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  replaced_by_token_id TEXT,           -- set on rotation
  revoked_at INTEGER
)

revoked_access_tokens(                 -- access token jti blocklist; rare, short-lived
  token_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)

password_reset_tokens(
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,            -- sha-256 of secret in the email link
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  request_ip TEXT
)

totp_recovery_codes(
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,             -- sha-256 of one-time code
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (account_username, code_hash)
)

invites(
  invite_id TEXT PRIMARY KEY,          -- uuid v4
  code_hash TEXT NOT NULL UNIQUE,      -- sha-256 of the human-readable code
  label TEXT,                          -- "for hasan" etc.
  created_by TEXT NOT NULL REFERENCES accounts(username),
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses_remaining INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,                  -- nullable = no expiry
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)

invite_redemptions(
  invite_id TEXT NOT NULL REFERENCES invites(invite_id) ON DELETE CASCADE,
  account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, account_username)
)

security_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,                 -- enum below
  actor_username TEXT,                 -- nullable for failed_login on unknown user
  target_username TEXT,                -- the affected account if different from actor
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT                   -- small JSON blob, schema per event
)

login_attempts(
  bucket_key TEXT PRIMARY KEY,         -- "user:akif" or "ip:1.2.3.4"
  attempts INTEGER NOT NULL,
  first_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  locked_until INTEGER
)

schema_version(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
)
```

### 2.3 Token model

**Access token (HMAC-SHA256, 15 minutes)** — claims:

```
{
  "sub": "akif",
  "ver": 7,            // accounts.token_version at issue time
  "rol": "user",       // for cheap admin checks without DB hit (still re-validated for state-changing ops)
  "iat": 1716592800000,
  "exp": 1716593700000,
  "jti": "uuid",
  "v": 2               // claim-schema version, bump on breaking change
}
```

Verified on every request. Rejection codes:
- `expired_token` — `exp` past
- `stale_token` — `ver` < current `accounts.token_version`
- `invalid_token` — signature fail / malformed / claim-schema mismatch
- `revoked_token` — `jti` in `revoked_access_tokens` (rare; used for immediate kill)
- `missing_account` — account row gone
- `account_disabled` — `accounts.disabled_at IS NOT NULL`
- `account_locked` — `accounts.locked_until > now`

**Refresh token (32 random bytes, base64url, 30 days)** — opaque. Server stores SHA-256 of the secret + `token_id` + `family_id`. Single-use: every successful `POST /api/auth/refresh` invalidates the presented refresh and issues a new pair. Rotated tokens carry the same `family_id`.

**Reuse detection:** if a refresh token's row has a non-null `replaced_by_token_id` and someone presents it again, the entire family is killed (`revoked_at = now` for all `family_id` matches), `accounts.token_version` is bumped (kills all access tokens), and `security_audit_log` records `refresh_reuse_detected` with severity flag.

### 2.4 Login flow (after Phase 6, 2FA mandatory)

```
POST /api/auth/login {username, password}
  → 200 {pending_token, requires: ["totp_enroll" | "totp_verify"]}
       pending_token is a 5-min HMAC bound to {sub, step}
       no access/refresh issued yet

  if account.totp_enabled_at IS NULL:
     client redirects to enrollment UI
     POST /api/auth/2fa/enroll (Bearer: pending_token)
       → 200 {secret_b32, qr_svg, recovery_codes[]}  // recovery codes shown ONCE
     POST /api/auth/2fa/enroll/confirm (Bearer: pending_token) {code}
       → 200 {access_token, refresh_token, user}     // step complete, login finalized

  else:
     POST /api/auth/2fa/verify (Bearer: pending_token) {code OR recovery_code}
       → 200 {access_token, refresh_token, user}
       recovery_code consumes one entry from totp_recovery_codes
```

The `pending_token` exists so the password verification step doesn't leave a usable session on the wire if the user closes the tab mid-2FA. Server holds no extra state; the token itself encodes the step.

### 2.5 Session lifecycle

| Event | Effect |
|-------|--------|
| Login (after 2FA) | Issue access + refresh; insert `refresh_tokens` row; emit `login_ok` |
| Refresh | Verify refresh hash; if reused → kill family + bump version + audit. Otherwise: insert new pair, mark old `replaced_by_token_id` |
| Logout (this device) | Mark refresh `revoked_at`; insert access `jti` into `revoked_access_tokens` |
| Logout all devices | Bump `token_version`; mark all `refresh_tokens` for user `revoked_at`; force-disconnect all sockets for that username |
| Change password | Same as logout-all + new login required after change |
| Disable account | Bump `token_version` + revoke all refresh + force-disconnect sockets |
| Delete account | Soft-delete: set `pending_delete_at`; same effects as disable. Hard delete (cascade) after 7 days by scheduled job |

### 2.6 Socket session enforcement

Two mechanisms:

1. **Active push** — when the server takes an action that should kill a user's sessions (logout-all, change-password, disable, delete), iterate `io.sockets.sockets` and `disconnect(true)` everything whose `socket.data.auth.username` matches.
2. **Passive recheck** — every 5 minutes per connected socket, re-resolve the auth session (token_version, account_disabled, locked_until). If invalid, disconnect.

Sockets re-authenticate on reconnect, so dropped connections naturally fall back through the standard middleware.

---

## 3. Phase 0 — Foundation

**Goal:** put the schema, migration runner, and config plumbing in place. No user-facing change. After this phase the app still behaves exactly as today.

### 3.1 Migration runner

Add `database/migrations/` with files like `001_init.sql`, `002_add_email.sql`, etc. New helper `database/migrate.js`:

- Reads `PRAGMA user_version`
- Applies any migration with `version > current`
- Wraps each migration in a transaction; aborts startup on failure
- Logs `migration_applied { from, to }`

Called from `database.js` on boot, before any prepared statements are compiled.

### 3.2 Schema migrations introduced now

```
001_init.sql                    -- captures current schema verbatim (idempotent CREATE TABLE IF NOT EXISTS)
002_accounts_security_columns   -- adds token_version, role, disabled_at, failed_login_count, locked_until
003_refresh_tokens              -- creates refresh_tokens + revoked_access_tokens
004_login_attempts              -- creates login_attempts
005_audit_log                   -- creates security_audit_log
006_email_columns               -- adds email + email_verified_at + email_pending* columns to accounts
007_password_reset_tokens       -- creates password_reset_tokens
008_totp_columns                -- adds totp_secret, totp_enabled_at; creates totp_recovery_codes
009_invites                     -- creates invites + invite_redemptions
010_pending_delete              -- adds accounts.pending_delete_at
```

All 10 ship together in Phase 0 so future phases never need a schema-change deploy. **The columns exist before the code that uses them.**

### 3.3 Hash format upgrade

New format: `scrypt$N=16384,r=8,p=1$<salt-b64url>$<hash-b64url>`.

`hashing.js` exports:
- `hashPassword(password)` → uses current default params, returns versioned string
- `verifyPassword(password, storedHash)` → handles both old (`scrypt$salt$hash`) and new format; returns `{ ok, needsRehash }`
- `getDefaultParams()` for centralized tuning

Login flow checks `needsRehash`; if true, rehashes with current params and updates `accounts.password_hash` (atomic UPDATE). This silently migrates everyone over time without forced password resets.

### 3.4 Config changes

`server/config.js`:

```diff
- authSecret: process.env.AUTH_SECRET || process.env.PASSWORD || '',
+ authSecret: process.env.AUTH_SECRET || '',
- registrationInviteCode: process.env.REGISTRATION_INVITE || process.env.PASSWORD || '',
+ legacyInviteCode: process.env.REGISTRATION_INVITE || '',  // honored only if LEGACY_INVITE_ENABLED
+ legacyInviteEnabled: readBoolean('LEGACY_INVITE_ENABLED', true),
+ refreshTokenTtlMs: readNumber('REFRESH_TOKEN_TTL_DAYS', 30) * 86_400_000,
+ accessTokenTtlMs: readNumber('ACCESS_TOKEN_TTL_MINUTES', 15) * 60_000,
+ pendingTokenTtlMs: 5 * 60_000,
+ emailProvider: process.env.EMAIL_PROVIDER || 'resend',
+ resendApiKey: process.env.RESEND_API_KEY || '',
+ smtpUrl: process.env.SMTP_URL || '',
+ emailFrom: process.env.EMAIL_FROM || '',
+ publicAppUrl: process.env.PUBLIC_APP_URL || '',
+ bootstrapAdminUsername: process.env.BOOTSTRAP_ADMIN_USERNAME || '',
+ totpIssuer: process.env.TOTP_ISSUER || 'SesApp',
```

Startup hard-fail when:
- `AUTH_SECRET` missing OR `< 32` bytes (compare `Buffer.byteLength` of UTF-8)
- (only after Phase 4 ships) `EMAIL_PROVIDER` is set but its credentials (`RESEND_API_KEY` or `SMTP_URL`) and `EMAIL_FROM` / `PUBLIC_APP_URL` are missing

**Breaking deploy step:** before Phase 0 reaches production, ops must:
1. Generate `AUTH_SECRET` (`openssl rand -base64 48`) and set in Railway
2. Set `REGISTRATION_INVITE` explicitly if it was previously inherited from `PASSWORD`
3. Confirm `LEGACY_INVITE_ENABLED=true` (default) so existing invite-code value still works during cutover

### 3.5 Audit log sink

`server/auth/audit.js` exports `record(event, ctx)`:

```js
function record(event, { actorUsername, targetUsername, ip, userAgent, metadata }) {
  db.insertAuditLog({
    ts: Date.now(),
    event,
    actorUsername: actorUsername ?? null,
    targetUsername: targetUsername ?? actorUsername ?? null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
  });
}
```

Phase 0 only wires the sink + an admin-only `GET /api/admin/audit-log` endpoint (admin role lands in Phase 5, but the endpoint exists guarded by a fail-closed `requireAdmin` stub that rejects everyone until Phase 5 makes roles real).

### 3.6 Tests

- `test/migrations.test.js` — runs the runner against a temp DB, asserts `user_version` after each step
- `test/hashing.test.js` — verifies old-format hashes still validate; new-format hashes round-trip; `needsRehash` flips when default params change
- `test/audit.test.js` — `record` writes; selecting back returns parsed metadata

---

## 4. Phase 1 — Security hardening

**Goal:** close the HIGH and MED audit items without changing the user-facing flow. Old tokens still work; UI is unchanged.

### 4.1 Login timing-oracle fix

`POST /api/auth/login` always runs `verifyPassword` with a stable dummy hash (computed once at module load) when the account doesn't exist. Returns the same `{ error, code }` shape with the same delay envelope.

Pseudo-code:

```js
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('base64url'));

async function login({ username, password, ip }) {
  const u = canonicalizeUsername(username);
  const account = db.getAccount(u);
  const target = account?.password_hash ?? DUMMY_HASH;
  const ok = verifyPassword(password, target).ok && !!account;
  if (!ok) return loginFail({ username: u, ip });
  return loginOk(account);
}
```

### 4.2 Login throttle + lockout

`server/auth/rate-limit.js`:

- Two buckets per attempt: `user:<canonical-username>` and `ip:<remote-ip>`. Both are updated atomically inside the login handler.
- Counters increment on failure; reset to 0 on success.
- Progressive backoff calculated from the bucket's `attempts` value, applied as a `setTimeout` before responding:
  - 1–2 fails → no delay
  - 3 → 1 s
  - 4 → 2 s
  - 5 → 5 s
  - 6 → 15 s
  - 7+ → 30 s
- Lockout when **either** bucket reaches 10 failures: `locked_until = now + 15 min`.
- During lockout, login returns `423 Locked` with `{ code: 'account_locked', retry_after_seconds }`. Successful login during lockout window is rejected even with correct password.
- A background job (every 5 min) wipes `login_attempts` rows where `last_attempt_at < now - 24h` and not locked.

Sliding-window via `first_attempt_at`: if `now - first_attempt_at > 1h`, reset and start over.

### 4.3 `token_version` enforcement

`auth-middleware.js` extended:

```js
const account = db.getAccount(session.username);
if (!account) return fail('missing_account');
if (account.disabled_at) return fail('account_disabled');
if (account.locked_until && account.locked_until > Date.now()) return fail('account_locked');
if (account.token_version !== session.tokenVersion) return fail('stale_token');
```

`verifyAuthToken` returns `tokenVersion: payload.ver`. Tokens issued before Phase 1 (which carry `v: 1` and no `ver`) are still accepted for the **14-day cutover window** with `tokenVersion = 1` and a synthetic comparison against the user's current version. After cutover, legacy `v: 1` tokens are rejected with `code: 'legacy_token'`.

### 4.4 Revoked-tokens prune

`database.js` exports `pruneRevokedTokens()` which executes both `pruneRevokedTokensStmt` (existing) and a new one for `revoked_access_tokens`. Scheduled in `server.js`:

```js
pruneRevokedTokens();
setInterval(pruneRevokedTokens, 6 * 60 * 60 * 1000).unref();
```

### 4.5 Password strength

`validators.js`:

- Min length 8, max 128
- Reject if in bundled top-10k breached list (loaded once at startup from `server/auth/breached-passwords.txt`, ~80KB)
- Reject if zxcvbn score < 2 (use `zxcvbn` package, ~400KB; loaded lazily because it's only used during register / change-password)
- Error messages localized in Turkish; include the specific reason

### 4.6 Username canonicalization

`validators.js`:

```js
const USERNAME_REGEX = /^[a-z0-9_]{2,20}$/;

function canonicalizeUsername(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  return USERNAME_REGEX.test(trimmed) ? trimmed : null;
}

function validateDisplayName(input) {
  // 2–32 visible characters, no control chars, no zero-width
  ...
}
```

Migration 002 backfill: for each existing `accounts` row, set `display_name = username` then lowercase the `username` column. Conflict-handling: if two rows would collide after lowercase, suffix the later-created one with `_1`, `_2`, etc., and emit an admin notification entry in `security_audit_log` so the operator can rename them properly.

### 4.7 Invite-code constant-time compare

`server/auth-routes.js` registration handler:

```js
function timingSafeStringEqual(a, b) {
  const buf1 = Buffer.from(String(a), 'utf8');
  const buf2 = Buffer.from(String(b), 'utf8');
  if (buf1.length !== buf2.length) {
    // still consume time by comparing against itself
    crypto.timingSafeEqual(buf1, buf1);
    return false;
  }
  return crypto.timingSafeEqual(buf1, buf2);
}
```

Applied to legacy invite check (Phase 1) and the per-invite hashed-code check (Phase 5).

### 4.8 Registration response shape

Registration always returns a uniform shape on the happy path. On collision it still returns `409`, but the error message is generic: `"Bu kullanıcı adı kullanılamıyor."` (no "already taken"). Combined with the timing-oracle fix on login (4.1), there is no clean enumeration channel left.

### 4.9 Audit events recorded in this phase

| Event | Trigger |
|-------|---------|
| `login_ok` | Successful password match (pre-2FA from Phase 6's perspective; in Phase 1 it's the only step) |
| `login_fail` | Any failure: bad password, unknown user, lockout-hit, locked account |
| `lockout_triggered` | A bucket crosses the 10-attempt threshold |
| `password_rehashed` | Login auto-upgraded stored hash to current params |
| `legacy_token_used` | A pre-Phase-1 `v: 1` token was accepted (sample-logged, not on every request) |
| `legacy_token_rejected` | Same but after the 14-day cutover |

### 4.10 Tests

- `test/auth-login-throttle.test.js` — repeated fails delay; 10th fail locks; correct pw during lockout still rejected
- `test/auth-token-version.test.js` — token issued, version bumped, next request rejected with `stale_token`
- `test/auth-canonicalization.test.js` — `Akif`/`akif`/`AKIF` resolve to one account; emoji/RTL rejected
- `test/auth-password-strength.test.js` — `password`, `123456`, dictionary words rejected; strong password accepted

---

## 5. Phase 2 — Token redesign (access + refresh)

**Goal:** kill the two remaining HIGH items (#3 socket revocation, #6 long-lived tokens) by reshaping the token model.

### 5.1 New endpoints

- `POST /api/auth/refresh` — body `{ refresh_token }`. Returns new `{ access_token, refresh_token }` and rotates.
- `POST /api/auth/logout` — accepts both Authorization-header access token AND body `{ refresh_token }`; revokes both.

### 5.2 Issuing a session

On successful login (and refresh):

```js
function issueSession({ account, deviceLabel, ip, userAgent, familyId }) {
  const accessJti = crypto.randomUUID();
  const access = createAccessToken({
    sub: account.username,
    ver: account.token_version,
    rol: account.role,
    jti: accessJti,
    ttlMs: config.accessTokenTtlMs,
  });

  const refreshSecret = crypto.randomBytes(32).toString('base64url');
  const refreshId = crypto.randomUUID();
  db.insertRefreshToken({
    tokenId: refreshId,
    tokenHash: sha256(refreshSecret),
    accountUsername: account.username,
    familyId: familyId ?? refreshId,         // first issue: family = self
    deviceLabel,
    ip,
    userAgent,
    expiresAt: Date.now() + config.refreshTokenTtlMs,
  });

  const refresh = `${refreshId}.${refreshSecret}`;
  return { access, refresh };
}
```

The refresh wire-format is `<token_id>.<secret>` so the server can look up the row by `token_id` without iterating, then compare the hash with `timingSafeEqual`.

### 5.3 Refresh rotation + reuse detection

```js
async function refresh({ refreshWire, ip, userAgent }) {
  const [tokenId, secret] = parseRefresh(refreshWire);
  const row = db.getRefreshToken(tokenId);

  if (!row || !timingSafeEqual(sha256(secret), row.token_hash)) {
    return fail('invalid_refresh');
  }
  if (row.expires_at <= Date.now()) return fail('expired_refresh');
  if (row.revoked_at) return fail('revoked_refresh');

  if (row.replaced_by_token_id) {
    // REUSE — kill family + bump version + audit
    db.revokeRefreshFamily(row.family_id);
    db.bumpTokenVersion(row.account_username);
    forceDisconnectUserSockets(row.account_username);
    audit.record('refresh_reuse_detected', {
      actorUsername: row.account_username,
      ip, userAgent,
      metadata: { family_id: row.family_id, token_id: tokenId },
    });
    return fail('refresh_reuse_detected');
  }

  const account = db.getAccount(row.account_username);
  if (!account || account.disabled_at) return fail('account_unavailable');
  if (account.token_version !== row.account_token_version_at_issue) {
    // version bumped since issue → reject quietly, client must re-login
    return fail('stale_session');
  }

  // happy path: rotate
  const next = issueSession({
    account,
    deviceLabel: row.device_label,
    ip, userAgent,
    familyId: row.family_id,
  });
  db.markRefreshReplaced(tokenId, next.refresh_token_id);
  return next;
}
```

`account_token_version_at_issue` is stored on each `refresh_tokens` row so a version bump invalidates the whole chain on next refresh.

### 5.4 Socket enforcement

`server/realtime-state.js` exposes `forceDisconnectUser(username, reason)`:

```js
function forceDisconnectUser(username, reason) {
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data?.auth?.username === username) {
      socket.emit('auth_error', { code: reason, message: '...' });
      socket.disconnect(true);
    }
  }
}
```

Called from: logout-all, change-password, disable-account, refresh-reuse-detection, role-change-to-disabled.

Periodic recheck — in the socket auth middleware, after handshake succeeds, attach a `setInterval(() => recheck(socket), 5*60*1000)` that re-resolves the session and disconnects on any failure. Clear on `disconnect`. Memory cost is bounded by connected-user count.

### 5.5 Client changes

- New module `public/auth-client.js` extracted from `app.js`:
  - `getAccessToken()` returns the in-memory token
  - `authorizedFetch(url, opts)` retries once via `/api/auth/refresh` on 401 with code `expired_token`
  - On refresh failure → `forceLogout()` (clears localStorage, shows login screen with reason message)
- Refresh token in `localStorage` under `sesappRefreshToken`. Access token is NEVER persisted.
- On boot: if a refresh exists, call `/api/auth/refresh` first to mint an access token, then proceed.
- Socket connection waits for an access token before `io({ auth: { token } })`.

### 5.6 Migration of existing tokens

Existing 30-day `v: 1` tokens accepted as bearer for **14 days** after Phase 2 deploys. Phase 1 already added the version field. On any request carrying a legacy token, the server transparently issues a Set-Cookie-style hint (custom header `X-Auth-Migrate: refresh`) telling the client "please call /api/auth/login or refresh path soon". After 14 days, legacy tokens are rejected with `code: 'legacy_token'` and the client falls through to the login screen.

### 5.7 Tests

- `test/refresh-rotation.test.js` — issuing returns distinct tokens; using old after rotate fails with `refresh_reuse_detected`; using new succeeds
- `test/refresh-reuse-kills-family.test.js` — issue → rotate to B → reuse original → confirm B is also revoked
- `test/socket-force-disconnect.test.js` — logout-all on user with 2 connected sockets disconnects both with `auth_error`
- `test/access-token-ttl.test.js` — token rejected at exp + 1ms

---

## 6. Phase 3 — Account management

**Goal:** the user can manage their own account from the UI.

### 6.1 Endpoints

| Method | Path | Body | Behavior |
|--------|------|------|----------|
| `POST` | `/api/auth/change-password` | `{ current_password, new_password }` | Verify current with scrypt. Apply new-password validators. Update hash. Bump `token_version`. Revoke all refresh tokens for user. Audit `password_change`. Force-disconnect sockets. Client must re-login. |
| `POST` | `/api/auth/change-email` | `{ new_email, current_password }` | Verify password. Stash in `email_pending` + send verification mail to new address (Phase 4 plumbing). Mail to old address: "Your email change was requested; if not you, click here to revoke." |
| `POST` | `/api/auth/change-email/confirm` | `{ token }` | Move `email_pending` → `email`; clear pending fields; audit `email_changed`. |
| `GET` | `/api/auth/sessions` | — | List active refresh tokens for current user (not revoked, not expired). Each row: `{ id, device_label, ip, last_used_at, created_at, is_current }`. |
| `DELETE` | `/api/auth/sessions/:id` | — | Revoke one refresh token + force-disconnect sockets created in its window (best-effort by token issue time + matching UA — Phase 3.4). |
| `POST` | `/api/auth/sessions/logout-all` | — | Bump `token_version`, revoke all refresh tokens, force-disconnect all sockets for user. |
| `POST` | `/api/auth/account/delete` | `{ current_password }` | Verify password. Set `pending_delete_at = now + 7 days`. Same effect as disable. Background job (daily) hard-deletes rows where `pending_delete_at < now`. |
| `POST` | `/api/auth/account/restore` | — | If user re-logs into a pending-delete account, clear `pending_delete_at`, audit `account_restore`. |

### 6.2 Display-name change

`POST /api/auth/change-display-name` — body `{ display_name }`. Updates `accounts.display_name` only. Username (canonical) is immutable. Broadcasts a user-list refresh via Socket.io.

### 6.3 Settings UI

New screen `Hesabım` (My Account) in `public/index.html`, opened from a gear icon next to the username panel. Sections:

1. **Profil** — display name editor
2. **Şifre** — change-password form (current pw + new pw + confirm)
3. **E-posta** — current email, change-email form, "Doğrulanmadı" badge if pending
4. **Aktif oturumlar** — table of sessions, "Bu cihaz" badge on current, "Çıkış yap" button per row, "Tüm cihazlardan çıkış" button
5. **Tehlikeli bölge** — delete account (collapsed; requires password + a typed confirmation phrase)

### 6.4 Sessions current-device detection

The access token carries `jti`; when the access was issued, server inserted the refresh row with `replaced_by_token_id = null` and `last_used_at = now`. Server keeps a transient in-memory map `accessJti → refreshId` (rebuilt from `refresh_tokens` on demand) so `/api/auth/sessions` can flag the current row. The map is purely a hint — UI badge — and resets on server restart.

### 6.5 Tests

- `test/change-password.test.js` — wrong current pw rejected; right pw rotates token_version + revokes refresh
- `test/sessions-list.test.js` — three logins from three "devices" → list returns three rows
- `test/delete-account.test.js` — soft-delete sets pending_delete_at; restore clears it; hard-delete job removes after 7 days

---

## 7. Phase 4 — Password reset via email

**Goal:** users with a verified email can self-serve reset.

### 7.1 Email provider abstraction

`server/auth/email.js`:

```js
function createEmailService({ provider, config, logger }) {
  switch (provider) {
    case 'resend': return resendAdapter(config);
    case 'smtp':   return smtpAdapter(config);
    case 'noop':   return noopAdapter(logger);   // tests / dev without keys
    default:       throw new Error(`unknown email provider: ${provider}`);
  }
}

// All adapters expose:
//   sendPasswordReset({ to, displayName, resetUrl, expiresInMin })
//   sendEmailVerification({ to, displayName, verifyUrl, expiresInMin })
//   sendEmailChangeNotification({ to, displayName, requestedFrom, revokeUrl })
```

Resend adapter uses `fetch` against `https://api.resend.com/emails`. SMTP adapter uses `nodemailer` (new dep). The `noop` adapter writes to a per-test buffer and is the default when `NODE_ENV === 'test'` or `EMAIL_PROVIDER === 'noop'`.

### 7.2 Reset flow

```
POST /api/auth/forgot-password { email }
  → 204 always (no enumeration)
  → if email matches an account.email (verified):
       generate 32-byte secret
       insert password_reset_tokens row { token_hash: sha256(secret), expires_at: now+60min }
       send email with link `${PUBLIC_APP_URL}/reset-password?token=<id>.<secret>`
  → if not: just emit `reset_requested_unknown_email` audit event

GET /reset-password?token=...
  → static page, prompts for new password

POST /api/auth/reset-password { token, new_password }
  → look up by token id, timing-safe-compare hash
  → reject if expired / already used
  → validate new password
  → atomic transaction:
      mark token used
      update password_hash
      bump token_version
      revoke all refresh tokens
  → force-disconnect sockets
  → audit `password_reset_used`
  → return 200; client redirects to login screen
```

### 7.3 Rate limits

- Per-email (hashed): max 5 requests / hour
- Per-IP: max 20 requests / hour
- Per-account: max 3 active reset tokens at once (older ones are invalidated when a 4th is requested)

Implemented by extending `login_attempts` with bucket prefixes `email:` and `reset-ip:`.

### 7.4 Legacy accounts without email

Phase 0 already added the column nullable. Phase 4 also adds:

- A non-blocking banner in the client for accounts where `email IS NULL`: "Şifreni unutursan kurtaramayız. E-posta ekle."
- An admin endpoint `POST /api/admin/users/:username/email-set` to set email on behalf of a user during the transition (for users who can't log in to add it themselves).

Registration after Phase 4 requires `email`. The column stays nullable in SQLite (legacy rows already exist with `NULL`); the requirement is enforced at the application layer in the registration handler. A SQL `CHECK` constraint is intentionally not added because it would be retroactive and would force-NULL-fill existing rows in a way that's hard to reason about.

### 7.5 Tests

- `test/forgot-password-no-enum.test.js` — unknown email returns 204 with same shape and same timing
- `test/reset-token-single-use.test.js` — second use of same token fails with `code: 'used_or_expired'`
- `test/email-provider-noop.test.js` — captures emails in-process; asserts subject + link presence
- `test/reset-rate-limit.test.js` — 6th request in an hour returns 429

---

## 8. Phase 5 — Invites + Roles + Admin

**Goal:** scale beyond a single shared invite code and make `admin` a real role.

### 8.1 Invite codes

- Human-readable code: 12 chars, base32-without-confusables (Crockford), e.g. `H7K2-9XQP-3WMN`
- Stored only as `sha256(code)` in `invites.code_hash`; the raw code is shown ONCE to the admin when minted and cannot be recovered server-side
- Atomic redemption: registration handler does

```sql
UPDATE invites
SET uses_remaining = uses_remaining - 1
WHERE code_hash = ?
  AND uses_remaining > 0
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > ?)
```

If 1 row updated → proceed with account creation in same transaction → insert `invite_redemptions` row → commit. Otherwise → reject `invalid_invite`.

### 8.2 Admin endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET`    | `/api/admin/invites` | — | `[{ id, label, max_uses, uses_remaining, expires_at, created_by, created_at, revoked_at }]` |
| `POST`   | `/api/admin/invites` | `{ label?, max_uses?, ttl_hours? }` | `{ id, code }` — code shown ONCE |
| `DELETE` | `/api/admin/invites/:id` | — | 204 |
| `GET`    | `/api/admin/users` | `?q=&disabled=` | paginated list |
| `POST`   | `/api/admin/users/:username/disable` | — | sets `disabled_at`, kills sessions, audits |
| `POST`   | `/api/admin/users/:username/enable` | — | clears `disabled_at` |
| `POST`   | `/api/admin/users/:username/role` | `{ role: "user"|"admin" }` | bumps version, audits `role_change` |
| `POST`   | `/api/admin/users/:username/logout-all` | — | same as the user's own logout-all |
| `DELETE` | `/api/admin/users/:username` | `{ confirmation_phrase }` | soft-delete with 7-day grace |
| `GET`    | `/api/admin/audit-log` | `?event=&actor=&since=&until=&limit=` | last N audit rows |

### 8.3 Admin bootstrap

On startup, after migrations:

1. If `BOOTSTRAP_ADMIN_USERNAME` env is set and that account exists → ensure its `role = 'admin'`, audit `bootstrap_admin_set` on change
2. Else if zero accounts have `role = 'admin'` and at least one account exists → first account by `created_at ASC` is promoted to admin, audit `bootstrap_admin_first_user`
3. Else → no-op

The intent: never leave a deployed instance without an admin. The audit log records exactly which rule fired.

### 8.4 `requireAdmin` middleware

```js
function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ code: 'missing_token' });
  if (req.auth.role !== 'admin') {
    audit.record('admin_access_denied', { actorUsername: req.auth.username, ip: req.ip, metadata: { path: req.path } });
    return res.status(403).json({ code: 'forbidden' });
  }
  // double-check against DB in case the access token's `rol` is stale (role demoted after issue)
  const fresh = db.getAccount(req.auth.username);
  if (fresh?.role !== 'admin') {
    return res.status(403).json({ code: 'forbidden' });
  }
  next();
}
```

### 8.5 Legacy invite cutover

`LEGACY_INVITE_ENABLED=true` keeps the old single-secret invite working alongside the new per-invite system for 30 days. Operator flips to `false` after Phase 5 has been live for 30 days. Audit `legacy_invite_used` records every use during the cutover so the admin can monitor adoption.

### 8.6 Admin UI

Separate `/admin` route in `public/`, gated client-side by `user.role === 'admin'` (real enforcement is server-side). Three tabs: Users / Invites / Audit. Plain HTML, no framework — matches the rest of the app.

### 8.7 Tests

- `test/invite-atomic-redemption.test.js` — concurrent registration with `uses_remaining = 1` only succeeds once
- `test/admin-role-required.test.js` — non-admin → 403 on every `/api/admin/*` route
- `test/admin-bootstrap.test.js` — three startup scenarios: env-set, first-user-promoted, no-op
- `test/admin-disable-user.test.js` — disabled user can't log in and gets booted from active sockets

---

## 9. Phase 6 — Mandatory 2FA (TOTP)

**Goal:** every account must have TOTP enrolled. No bypass.

### 9.1 Why mandatory changes the flow

Because 2FA is required for everyone, every account is in one of three states:

| State | Definition | What login returns |
|-------|------------|--------------------|
| `totp_pending_enroll` | password set, `totp_enabled_at IS NULL` | `pending_token` + `requires: ["totp_enroll"]` |
| `totp_active` | `totp_enabled_at IS NOT NULL` | `pending_token` + `requires: ["totp_verify"]` |
| `totp_recovery_only` | enrolled but TOTP secret rotated by user; only recovery codes usable for one login | `pending_token` + `requires: ["totp_recovery"]` |

The `pending_token` is a separate HMAC with claims `{ sub, step, iat, exp: iat+5min, jti, v: 2 }`. It is NOT an access token and grants only the right to complete enrollment or verify TOTP for that user. Its presence in any other auth-middleware-protected route is rejected (the middleware checks `step` is absent).

### 9.2 Endpoints

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `POST` | `/api/auth/2fa/enroll` | pending_token (step=enroll) | — | `{ secret_b32, otpauth_url, qr_svg, recovery_codes: [10 codes] }` |
| `POST` | `/api/auth/2fa/enroll/confirm` | pending_token (step=enroll) | `{ code }` | `{ access_token, refresh_token, user }` — login finalized |
| `POST` | `/api/auth/2fa/verify` | pending_token (step=verify) | `{ code }` | `{ access_token, refresh_token, user }` |
| `POST` | `/api/auth/2fa/recovery` | pending_token (step=verify) | `{ recovery_code }` | same as above, marks code used |
| `POST` | `/api/auth/2fa/regenerate-recovery` | full access token | `{ current_password }` | `{ recovery_codes: [10 codes] }` — shown ONCE |
| `POST` | `/api/auth/2fa/reset` (admin) | admin access token | `{ username }` | clears `totp_secret` + `totp_enabled_at`, deletes recovery codes, bumps token_version |

There is **no user-facing "disable 2FA" endpoint** — that would defeat "mandatory". If a user loses their device + all recovery codes, they must contact an admin (`/api/auth/2fa/reset`).

### 9.3 TOTP implementation

`server/auth/totp.js`:

- Secret: 20 random bytes, base32-encoded (RFC 4648)
- Algorithm: SHA-1, 6-digit code, 30-second step (most compatible with authenticators)
- `otpauth_url` format: `otpauth://totp/${TOTP_ISSUER}:${username}?secret=${secret}&issuer=${TOTP_ISSUER}&algorithm=SHA1&digits=6&period=30`
- QR rendered server-side as SVG (`qrcode` dep, `toString` mode); avoids loading a QR lib in the client
- Verification: accept ±1 time-step window (handles small clock drift). Reject any code already used in the last 90 seconds for that user (small in-memory dedup map; prevents replay within a step's lifetime).

### 9.4 Recovery codes

- 10 codes per account, generated on enrollment and on `regenerate-recovery`
- Format: `XXXX-XXXX-XXXX` (12 chars Crockford base32)
- Stored as `sha256(code)` in `totp_recovery_codes`
- Single-use: `UPDATE ... SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`
- Regenerating invalidates all previous codes
- Audit `recovery_codes_regenerated`, `recovery_code_used`

### 9.5 Migration for existing users

Phase 6 release flips a flag: every account where `totp_enabled_at IS NULL` is forced into `totp_pending_enroll` state on next login. The client routes them to enrollment, blocks app usage until done.

Operators should announce the change before the release because every existing user needs an authenticator app. Recovery codes are shown ONCE; we strongly nudge users to save them (UI shows download + print + copy buttons before allowing "I saved them" to proceed).

### 9.6 Admin 2FA reset

Only admins can reset another user's 2FA. Process:

1. Admin calls `/api/auth/2fa/reset { username }`
2. Server clears the secret + recovery codes, sets `totp_enabled_at = NULL`, bumps token_version, kills sessions, audits `admin_totp_reset` with `target_username`
3. Next time the user logs in, they're back in `totp_pending_enroll` and must re-enroll

Out-of-band identity verification (the admin should confirm the request is legitimate) is the admin's responsibility — the app cannot prove this. Documented in the operations playbook.

### 9.7 Tests

- `test/totp-verify-window.test.js` — codes at t−30, t, t+30 accepted; t−60, t+60 rejected
- `test/totp-replay-blocked.test.js` — same code accepted once, second attempt within 90s rejected
- `test/totp-enrollment-flow.test.js` — pending_token → enroll → confirm bad code → confirm good code → access + refresh issued
- `test/recovery-code-single-use.test.js` — code accepted once, second attempt rejected
- `test/admin-totp-reset.test.js` — admin reset clears state and forces re-enrollment on next login

---

## 10. Cross-cutting concerns

### 10.1 Backwards compatibility timeline

| Item | When introduced | When removed |
|------|-----------------|--------------|
| Legacy `scrypt$salt$hash` format verification | Phase 0 | Never (passive migration) |
| Legacy `v: 1` 30-day token acceptance | Phase 1 (cutover starts) | Phase 1 + 14 days |
| `AUTH_SECRET → PASSWORD` fallback | — | Phase 0 (breaking deploy step) |
| `REGISTRATION_INVITE` env (single shared) | — | Phase 5 + 30 days (`LEGACY_INVITE_ENABLED=false`) |
| `email IS NULL` accounts | Phase 4 | Pre-Phase-4 accounts kept; new accounts must have email |
| Accounts without TOTP | Phase 6 | Phase 6 release + immediate (forced enrollment on next login) |

### 10.2 Configuration matrix

After all phases, full env surface:

```
# Required, fail-closed at startup
AUTH_SECRET                  ≥ 32 bytes, used to sign access & pending tokens
PUBLIC_APP_URL               https://sesapp.example  (used in email links)

# Required once email provider is enabled (Phase 4)
EMAIL_PROVIDER               resend | smtp | noop
RESEND_API_KEY               (if resend)
SMTP_URL                     (if smtp)
EMAIL_FROM                   "SesApp <no-reply@sesapp.example>"

# Optional, with defaults
ACCESS_TOKEN_TTL_MINUTES     15
REFRESH_TOKEN_TTL_DAYS       30
TOTP_ISSUER                  SesApp
BOOTSTRAP_ADMIN_USERNAME     ""
LEGACY_INVITE_ENABLED        true  (Phase 5; flip to false after 30d cutover)
REGISTRATION_INVITE          ""    (legacy, only honored when LEGACY_INVITE_ENABLED=true)

# Unchanged
PORT, SOCKET_*, API_RATE_*, RTC_ICE_SERVERS_JSON, TURN_*
```

### 10.3 Documentation deliverables

`docs/auth/`:

- `overview.md` — architecture diagram, token model, lifecycle
- `email-setup.md` — Resend signup, SPF/DKIM, EMAIL_FROM verification
- `admin-bootstrap.md` — three bootstrap modes, how to promote a user manually
- `migration-runbook.md` — phase-by-phase deploy checklist with go/no-go criteria
- `incident-response.md` — playbook for: leaked refresh token, compromised account, lost 2FA, mass-lockout false-positive

### 10.4 Rate-limit summary

| Surface | Limit |
|---------|-------|
| `/api/auth/login` | Progressive 1–30s delay per-user + per-IP, lockout at 10 fails / 15 min |
| `/api/auth/refresh` | 60 / minute per IP (cheap endpoint, but not free) |
| `/api/auth/forgot-password` | 5 / hour per email, 20 / hour per IP |
| `/api/auth/reset-password` | 10 / hour per IP |
| `/api/auth/2fa/verify` | 10 / minute per pending_token; pending_token expires at 5 min anyway |
| `/api/admin/*` | Standard 100 / 15min via `/api/` limiter |
| Socket.io connection | Existing `SOCKET_RATE_*` limits |

### 10.5 Testing strategy

- **Unit tests** (`node --test`): all of `server/auth/*` modules
- **Integration tests**: a `test/integration/` directory that spins up the real app against a temp SQLite file and `noop` email provider. Covers each phase's end-to-end happy path + at least one failure path
- **Smoke test** (`npm run smoke`): extended with login → refresh → logout cycle and a forgot-password trigger that asserts the noop email captured the link
- **Manual checklist**: per-phase manual test list embedded in `migration-runbook.md`

### 10.6 Rollout order and go/no-go gates

| Phase | Ships when | Rollback plan |
|-------|------------|---------------|
| 0 | All migrations green on staging; `AUTH_SECRET` set in Railway | Re-deploy previous image; migrations are additive and safe to keep |
| 1 | All audit-item tests green; throttle behavior verified manually | Per-flag rollback (e.g., disable throttle by env `LOGIN_THROTTLE_ENABLED=false`) |
| 2 | Refresh rotation + reuse-detection integration tests green; 14-day cutover scheduled | Re-enable legacy token acceptance; ship-back to Phase 1 client bundle |
| 3 | Settings UI smoke-tested in Electron and browser | Hide settings panel via feature flag; endpoints stay live (read-only operations remain safe) |
| 4 | Email delivery verified end-to-end on staging (real Resend send to a test inbox) | Set `EMAIL_PROVIDER=noop` to silently disable; reset-password endpoint returns 503 |
| 5 | First admin bootstrapped; legacy invite working alongside new invites | Set `LEGACY_INVITE_ENABLED=true`, keep new invite endpoints live (no harm) |
| 6 | TOTP enrollment + verify tested across at least 2 authenticator apps; recovery code flow verified | **No clean rollback** — once accounts have TOTP enrolled, removing the requirement requires per-user opt-out. Ship behind a `MFA_REQUIRED=true` flag that operations can flip off for emergency mitigation; users will keep their TOTP but app stops requiring it |

---

## 11. Open questions left for the implementation plan

1. **`zxcvbn` dependency size** — ~400 KB. If client-side strength feedback is wanted later, that's separate. For server-side scoring, fine.
2. **Resend vs SMTP default** — spec says Resend default with SMTP available. Confirm Resend is acceptable before Phase 4 starts (the brainstorm Q&A didn't lock this; spec assumes yes).
3. **Display-name uniqueness** — current spec lets two users have the same display name (only canonical username is unique). If you'd prefer enforced uniqueness, that's a Phase 3 schema tweak.
4. **Admin audit-log retention** — spec writes audit log forever. If volume becomes a concern, add a prune job (keep last 365 days). Probably fine to defer.
5. **Electron auto-update implications** — refresh-token flow assumes the client is current. Electron users on stale builds need a graceful "please update" path if claim-schema version `v` bumps. Out of scope for this spec.

These don't block writing the implementation plan; they're knobs to confirm or revisit during it.
