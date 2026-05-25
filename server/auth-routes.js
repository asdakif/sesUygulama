'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  canonicalizeUsername,
  createPendingAuthToken,
  hashPassword,
  normalizeEmail,
  validateAuthCode,
  validateEmail,
  validateDisplayName,
  validatePassword,
  validateUsername,
  verifyPendingAuthToken,
  verifyPassword,
} = require('./auth');
const { createEmailService } = require('./auth/email');
const {
  createSessionManager,
  hashOpaqueTokenSecret,
  parseRefreshToken,
} = require('./auth/sessions');

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    if (leftBuffer.length > 0) crypto.timingSafeEqual(leftBuffer, leftBuffer);
    if (rightBuffer.length > 0) crypto.timingSafeEqual(rightBuffer, rightBuffer);
    return false;
  }
  return leftBuffer.length > 0 && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWindowLimiter({ db, prefix, maxAttempts, windowMs }) {
  function consume(rawKey, now = Date.now()) {
    const normalizedKey = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!normalizedKey) return { ok: true };

    const bucketKey = `${prefix}:${normalizedKey}`;
    const row = db.getLoginAttempt(bucketKey);
    const outsideWindow = !row || (now - row.first_attempt_at) > windowMs;
    const attempts = outsideWindow ? 1 : row.attempts + 1;
    const firstAttemptAt = outsideWindow ? now : row.first_attempt_at;
    const retryAfterMs = outsideWindow ? 0 : Math.max(0, windowMs - (now - firstAttemptAt));

    if (attempts > maxAttempts) {
      return {
        ok: false,
        retryAfterMs,
      };
    }

    db.upsertLoginAttempt({
      bucketKey,
      attempts,
      firstAttemptAt,
      lastAttemptAt: now,
      lockedUntil: null,
    });

    return { ok: true };
  }

  return { consume };
}

function hashBucketValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function generateEmailAuthCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashEmailAuthCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function maskEmailAddress(email) {
  const [localPart, domainPart] = String(email || '').split('@');
  if (!localPart || !domainPart) return '';
  const safeLocal = localPart.length <= 2
    ? `${localPart[0] || '*'}*`
    : `${localPart.slice(0, 2)}${'*'.repeat(Math.max(2, localPart.length - 2))}`;
  return `${safeLocal}@${domainPart}`;
}

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function generateInviteCode() {
  let raw = '';
  for (let i = 0; i < 12; i += 1) {
    raw += INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function sendApiError(res, status, message, code = null, extra = {}) {
  const payload = { error: message, ...extra };
  if (code) payload.code = code;
  res.status(status).json(payload);
}

function createRequireAdmin({ db, audit }) {
  return (req, res, next) => {
    if (!req.auth) {
      return sendApiError(res, 401, 'Giris yapman gerekiyor.', 'missing_token');
    }
    if (req.auth.role !== 'admin') {
      audit.record('admin_access_denied', {
        actorUsername: req.auth.username,
        ip: req.ip,
        userAgent: req.get?.('user-agent') || null,
        metadata: { path: req.path },
      });
      return sendApiError(res, 403, 'Bu alana erisim yetkin yok.', 'forbidden');
    }

    const freshAccount = db.getAccount(req.auth.username);
    if (!freshAccount || freshAccount.role !== 'admin') {
      audit.record('admin_access_denied', {
        actorUsername: req.auth.username,
        ip: req.ip,
        userAgent: req.get?.('user-agent') || null,
        metadata: { path: req.path, reason: 'stale_role' },
      });
      return sendApiError(res, 403, 'Bu alana erisim yetkin yok.', 'forbidden');
    }

    req.admin = freshAccount;
    next();
  };
}

function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const [scheme, token] = headerValue.trim().split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

function createAuthRouter({
  db,
  config,
  requireAuth,
  audit,
  forceDisconnectUser,
  disconnectSocketsMatching = () => 0,
  ensureAdminBootstrap = () => {},
  loginThrottle,
  logger,
}) {
  const router = express.Router();
  const requireAdmin = createRequireAdmin({ db, audit });
  const dummyHash = hashPassword(crypto.randomBytes(32).toString('base64url'));
  const dummyOpaqueTokenHash = hashOpaqueTokenSecret(crypto.randomBytes(32).toString('base64url'));
  const sessions = createSessionManager({
    db,
    config,
    audit,
    forceDisconnectUser,
  });
  const emailService = createEmailService({
    provider: config.emailProvider,
    config,
    logger: logger.child('email'),
  });
  const forgotEmailLimiter = createWindowLimiter({
    db,
    prefix: 'email',
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
  });
  const forgotIpLimiter = createWindowLimiter({
    db,
    prefix: 'reset-ip',
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
  });
  const resetUseIpLimiter = createWindowLimiter({
    db,
    prefix: 'reset-use-ip',
    maxAttempts: 10,
    windowMs: 60 * 60 * 1000,
  });
  const emailAuthAttemptLimiter = createWindowLimiter({
    db,
    prefix: 'email-auth',
    maxAttempts: 10,
    windowMs: 60 * 1000,
  });
  const emailAuthResendLimiter = createWindowLimiter({
    db,
    prefix: 'email-auth-resend',
    maxAttempts: 5,
    windowMs: 10 * 60 * 1000,
  });
  const refreshRateLimiter = rateLimit({
    windowMs: config.refreshRateWindowMs,
    max: config.refreshRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      sendApiError(
        res,
        429,
        'Cok sik oturum yenileme istegi gonderdin. Biraz sonra tekrar dene.',
        'too_many_refresh_requests',
      );
    },
  });

  function getPendingRequirement(step) {
    return step === 'email' ? 'email_code' : null;
  }

  function issuePendingChallenge(account, step, extra = {}) {
    const tokenId = crypto.randomUUID();
    return {
      pending_token: createPendingAuthToken({
        username: account.username,
        step,
        secret: config.authSecret,
        ttlMs: config.pendingTokenTtlMs,
        tokenId,
      }),
      requires: [getPendingRequirement(step)],
      user: sessions.buildUserPayload(account),
      delivery: extra.delivery || null,
      email_hint: extra.emailHint || null,
      pending_token_id: tokenId,
    };
  }

  function issueFullSession(account, req, res, extra = {}) {
    const session = sessions.issueSession({
      account,
      deviceLabel: req.get('user-agent') || null,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    audit.record('login_ok', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    logger.info('account_logged_in', { username: account.username });
    res.json({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      user: session.user,
      ...extra,
    });
  }

  function resolvePendingToken(req, expectedSteps = []) {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return {
        ok: false,
        status: 401,
        message: 'Dogrulama adimi icin giris yapman gerekiyor.',
        code: 'missing_pending_token',
      };
    }
    const pending = verifyPendingAuthToken(token, config.authSecret);
    if (!pending) {
      return {
        ok: false,
        status: 401,
        message: 'Dogrulama oturumu gecersiz ya da suresi dolmus.',
        code: 'invalid_pending_token',
      };
    }
    if (expectedSteps.length && !expectedSteps.includes(pending.step)) {
      return {
        ok: false,
        status: 403,
        message: 'Bu dogrulama adimi artik gecerli degil.',
        code: 'invalid_pending_step',
      };
    }
    const account = db.getAccount(pending.username);
    if (!account) {
      return {
        ok: false,
        status: 401,
        message: 'Hesap bulunamadi. Tekrar giris yap.',
        code: 'missing_account',
      };
    }
    if (account.disabled_at) {
      return {
        ok: false,
        status: 403,
        message: 'Bu hesap devre disi birakilmis.',
        code: 'account_disabled',
      };
    }
    if (account.locked_until && account.locked_until > Date.now()) {
      return {
        ok: false,
        status: 423,
        message: 'Hesap gecici olarak kilitli. Biraz sonra tekrar dene.',
        code: 'account_locked',
      };
    }
    return {
      ok: true,
      token,
      pending,
      account,
    };
  }

  function isEmailFlowEnabled() {
    if (!emailService.available) return false;
    if (emailService.mode === 'noop' && !config.emailAllowNoop) return false;
    return true;
  }

  function getPublicAppUrl(req) {
    if (config.publicAppUrl) return config.publicAppUrl.replace(/\/+$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  function buildOpaqueToken(tokenId) {
    const secret = crypto.randomBytes(32).toString('base64url');
    return {
      token: `${tokenId}.${secret}`,
      tokenHash: hashOpaqueTokenSecret(secret),
      secret,
    };
  }

  function verifyStoredOpaqueToken({ wireToken, expectedHash, fallbackHash = dummyOpaqueTokenHash }) {
    const parsed = parseRefreshToken(wireToken);
    const candidateHash = hashOpaqueTokenSecret(parsed?.secret || '');
    const actualBuffer = Buffer.from(candidateHash, 'utf8');
    const expectedBuffer = Buffer.from(expectedHash || fallbackHash, 'utf8');
    const matches = actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    return {
      ok: matches,
      parsed,
    };
  }

  function findEmailOwner(email, excludedUsername = null) {
    const verifiedAccount = db.getAccountByEmail(email);
    if (verifiedAccount && verifiedAccount.username !== excludedUsername) return verifiedAccount;
    const pendingAccount = db.getAccountByPendingEmail(email);
    if (pendingAccount && pendingAccount.username !== excludedUsername) return pendingAccount;
    return null;
  }

  async function dispatchVerificationEmail({ account, email, token, req }) {
    await emailService.sendEmailVerification({
      to: email,
      displayName: account.display_name || account.username,
      verifyUrl: `${getPublicAppUrl(req)}/confirm-email?token=${encodeURIComponent(token)}`,
      expiresInMin: Math.round(config.emailVerificationTokenTtlMs / 60_000),
    });
  }

  function getEmailMfaAddress(account) {
    return account?.email || account?.email_pending || null;
  }

  async function dispatchEmailAuthCode({ account, email, challengeId, req, reason = 'login' }) {
    const now = Date.now();
    const code = generateEmailAuthCode();
    db.upsertEmailAuthChallenge({
      challengeId,
      accountUsername: account.username,
      email,
      codeHash: hashEmailAuthCode(code),
      purpose: reason,
      createdAt: now,
      expiresAt: now + config.emailAuthCodeTtlMs,
    });
    await emailService.sendLoginCode({
      to: email,
      displayName: account.display_name || account.username,
      code,
      expiresInMin: Math.round(config.emailAuthCodeTtlMs / 60_000),
    });
    audit.record('email_auth_code_requested', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { reason, email },
    });
  }

  router.post('/auth/register', async (req, res) => {
    const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
    const canUseLegacyInvite = config.legacyInviteEnabled && config.registrationInviteCode;
    if (!canUseLegacyInvite && !inviteCode) {
      return sendApiError(res, 503, 'Yeni hesap kaydı şu anda kapalı.');
    }
    if (!isEmailFlowEnabled()) {
      return sendApiError(
        res,
        503,
        'Yeni hesap kaydi icin e-posta servisi hazir degil.',
        'email_unavailable',
      );
    }

    const usernameCheck = validateUsername(req.body?.username);
    if (!usernameCheck.ok) return sendApiError(res, 400, usernameCheck.message, 'invalid_username');

    const passwordCheck = validatePassword(req.body?.password, {
      username: usernameCheck.username,
      displayName: usernameCheck.displayName,
    });
    if (!passwordCheck.ok) return sendApiError(res, 400, passwordCheck.message, 'weak_password');

    const emailCheck = validateEmail(req.body?.email);
    if (!emailCheck.ok) return sendApiError(res, 400, emailCheck.message, 'invalid_email');
    if (findEmailOwner(emailCheck.email)) {
      return sendApiError(res, 409, 'Bu e-posta kullanilamiyor.', 'email_unavailable');
    }

    const useLegacyInvite = canUseLegacyInvite && timingSafeStringEqual(inviteCode, config.registrationInviteCode);
    const result = db.createAccountWithInvite(usernameCheck.username, hashPassword(req.body.password), {
      displayName: usernameCheck.displayName,
      inviteCode,
      useLegacyInvite,
      nowMs: Date.now(),
    });

    if (!result.ok) {
      if (result.reason === 'invalid_invite') {
        return sendApiError(res, 401, 'Davet kodu yanlış.', 'invalid_invite');
      }
      return sendApiError(res, 409, 'Bu kullanıcı adı kullanılamıyor.', 'username_unavailable');
    }

    const emailToken = buildOpaqueToken(result.account.username);
    const emailExpiresAt = Date.now() + config.emailVerificationTokenTtlMs;
    db.setAccountPendingEmail(result.account.username, emailCheck.email, emailToken.tokenHash, emailExpiresAt);

    let registrationWarning = null;
    const useEmailCodeMfa = config.mfaRequired;
    if (!useEmailCodeMfa) {
      try {
        await dispatchVerificationEmail({
          account: result.account,
          email: emailCheck.email,
          token: emailToken.token,
          req,
        });
      } catch (error) {
        registrationWarning = 'Dogrulama e-postasi su an gonderilemedi. Ayarlardan tekrar deneyebilirsin.';
        audit.record('email_verification_send_failed', {
          actorUsername: result.account.username,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          metadata: { reason: error?.message || 'unknown' },
        });
        logger.warn('email_verification_send_failed', {
          username: result.account.username,
          error: error?.message || String(error),
        });
      }
    }

    ensureAdminBootstrap();
    const bootstrappedAccount = db.getAccount(result.account.username) || result.account;

    audit.record('account_registered', {
      actorUsername: bootstrappedAccount.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    audit.record(useLegacyInvite ? 'legacy_invite_used' : 'invite_redeemed', {
      actorUsername: bootstrappedAccount.username,
      targetUsername: bootstrappedAccount.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { mode: useLegacyInvite ? 'legacy' : 'invite' },
    });
    if (!useEmailCodeMfa) {
      audit.record('email_verification_requested', {
        actorUsername: bootstrappedAccount.username,
        targetUsername: bootstrappedAccount.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { email: emailCheck.email },
      });
    }
    logger.info('account_registered', { username: bootstrappedAccount.username });

    if (config.mfaRequired) {
      const challenge = issuePendingChallenge(bootstrappedAccount, 'email', {
        delivery: 'email',
        emailHint: maskEmailAddress(emailCheck.email),
      });
      try {
        await dispatchEmailAuthCode({
          account: bootstrappedAccount,
          email: emailCheck.email,
          challengeId: challenge.pending_token_id,
          req,
          reason: 'register',
        });
      } catch (error) {
        registrationWarning = 'Giris kodu e-postana gonderilemedi. Tekrar kod isteyebilirsin.';
        audit.record('email_auth_code_send_failed', {
          actorUsername: bootstrappedAccount.username,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          metadata: { reason: error?.message || 'unknown', flow: 'register' },
        });
        logger.warn('email_auth_code_send_failed', {
          username: bootstrappedAccount.username,
          error: error?.message || String(error),
          flow: 'register',
        });
      }
      return res.status(201).json({
        ...challenge,
        warning: registrationWarning,
      });
    }

    const session = sessions.issueSession({
      account: bootstrappedAccount,
      deviceLabel: req.get('user-agent') || null,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    res.status(201).json({
      token: session.accessToken,
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      user: session.user,
      warning: registrationWarning,
    });
  });

  router.post('/auth/login', async (req, res) => {
    const usernameCheck = validateUsername(req.body?.username);
    const canonicalUsername = usernameCheck.ok
      ? usernameCheck.username
      : canonicalizeUsername(req.body?.username) || '';
    const attempt = loginThrottle.beginAttempt({
      username: canonicalUsername,
      ip: req.ip,
    });

    if (!attempt.ok) {
      audit.record('login_fail', {
        targetUsername: canonicalUsername || null,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: attempt.code },
      });
      return sendApiError(
        res,
        423,
        'Hesap geçici olarak kilitli. Biraz sonra tekrar dene.',
        'account_locked',
        { retry_after_seconds: Math.ceil((attempt.retryAfterMs || 0) / 1000) },
      );
    }

    const passwordCheck = validatePassword(req.body?.password, {
      username: canonicalUsername,
      displayName: usernameCheck.ok ? usernameCheck.displayName : canonicalUsername,
    });
    if (!passwordCheck.ok && req.body?.password) {
      // Weak passwords should still be accepted for login; only malformed payloads are blocked.
      if (typeof req.body?.password !== 'string') {
        return sendApiError(res, 400, 'Şifre gerekli.', 'invalid_password');
      }
    } else if (typeof req.body?.password !== 'string' || !req.body.password.length) {
      return sendApiError(res, 400, 'Şifre gerekli.', 'invalid_password');
    }

    const account = canonicalUsername ? db.getAccount(canonicalUsername) : null;
    const verification = verifyPassword(req.body.password, account?.password_hash || dummyHash);
    const loginAllowed = verification.ok && !!account;

    if (!loginAllowed) {
      const failure = loginThrottle.registerFailure({
        username: canonicalUsername || null,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      audit.record('login_fail', {
        targetUsername: canonicalUsername || null,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'invalid_credentials' },
      });
      await delay(failure.delayMs);
      if (failure.lockedUntil) {
        return sendApiError(
          res,
          423,
          'Hesap geçici olarak kilitli. Biraz sonra tekrar dene.',
          'account_locked',
          { retry_after_seconds: Math.ceil((failure.retryAfterMs || 0) / 1000) },
        );
      }
      return sendApiError(res, 401, 'Kullanıcı adı veya şifre yanlış.', 'invalid_credentials');
    }

    if (account.disabled_at) {
      audit.record('login_fail', {
        actorUsername: account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'account_disabled' },
      });
      return sendApiError(res, 403, 'Bu hesap devre dışı bırakılmış.', 'account_disabled');
    }

    if (account.locked_until && account.locked_until > Date.now()) {
      audit.record('login_fail', {
        actorUsername: account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'account_locked' },
      });
      return sendApiError(
        res,
        423,
        'Hesap geçici olarak kilitli. Biraz sonra tekrar dene.',
        'account_locked',
        { retry_after_seconds: Math.ceil((account.locked_until - Date.now()) / 1000) },
      );
    }

    loginThrottle.registerSuccess({ username: account.username, ip: req.ip });
    db.touchAccountLogin(account.username);

    if (verification.needsRehash) {
      db.updateAccountPasswordHash(account.username, hashPassword(req.body.password));
      audit.record('password_rehashed', {
        actorUsername: account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    let freshAccount = db.getAccount(account.username);
    if (freshAccount?.pending_delete_at) {
      db.clearPendingAccountDelete(freshAccount.username);
      audit.record('account_restore', {
        actorUsername: freshAccount.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      freshAccount = db.getAccount(account.username);
    }
    if (config.mfaRequired) {
      const mfaEmail = getEmailMfaAddress(freshAccount);
      if (!mfaEmail) {
        audit.record('login_fail', {
          actorUsername: freshAccount.username,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          metadata: { reason: 'missing_mfa_email' },
        });
        return sendApiError(
          res,
          409,
          'Bu hesap icin kullanilabilir bir e-posta bulunamadi. Yoneticiyle iletisime gec.',
          'missing_mfa_email',
        );
      }
      const challenge = issuePendingChallenge(freshAccount, 'email', {
        delivery: 'email',
        emailHint: maskEmailAddress(mfaEmail),
      });
      let loginWarning = null;
      try {
        await dispatchEmailAuthCode({
          account: freshAccount,
          email: mfaEmail,
          challengeId: challenge.pending_token_id,
          req,
          reason: 'login',
        });
      } catch (error) {
        loginWarning = 'Giris kodu e-postana gonderilemedi. Tekrar kod isteyebilirsin.';
        audit.record('email_auth_code_send_failed', {
          actorUsername: freshAccount.username,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          metadata: { reason: error?.message || 'unknown', flow: 'login' },
        });
        logger.warn('email_auth_code_send_failed', {
          username: freshAccount.username,
          error: error?.message || String(error),
          flow: 'login',
        });
      }
      return res.json({
        ...challenge,
        warning: loginWarning,
      });
    }

    const session = sessions.issueSession({
      account: freshAccount,
      deviceLabel: req.get('user-agent') || null,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    audit.record('login_ok', {
      actorUsername: freshAccount.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    logger.info('account_logged_in', { username: freshAccount.username });

    res.json({
      token: session.accessToken,
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      user: session.user,
    });
  });

  router.post('/auth/2fa/verify', (req, res) => {
    const pending = resolvePendingToken(req, ['email']);
    if (!pending.ok) {
      return sendApiError(res, pending.status, pending.message, pending.code);
    }
    const codeCheck = validateAuthCode(req.body?.code);
    if (!codeCheck.ok) {
      return sendApiError(res, 400, 'E-postana gelen 6 haneli kodu gir.', 'invalid_email_code');
    }

    const attempt = emailAuthAttemptLimiter.consume(`${pending.account.username}:${pending.pending.tokenId}`);
    if (!attempt.ok) {
      return sendApiError(
        res,
        429,
        'Cok fazla e-posta kodu denemesi yaptin. Bir dakika sonra tekrar dene.',
        'too_many_email_code_attempts',
      );
    }

    const consumed = db.consumeEmailAuthChallenge(
      pending.pending.tokenId,
      hashEmailAuthCode(codeCheck.code),
      Date.now(),
    );
    if (!consumed) {
      audit.record('email_auth_code_failed', {
        actorUsername: pending.account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return sendApiError(res, 401, 'E-postana gelen kod gecersiz ya da suresi dolmus.', 'invalid_email_code');
    }

    if (pending.account.email_pending) {
      db.confirmAccountPendingEmail(pending.account.username, Date.now());
    } else if (pending.account.email && !pending.account.email_verified_at) {
      db.setAccountEmail(pending.account.username, pending.account.email, Date.now());
    }
    const freshAccount = db.getAccount(pending.account.username);
    audit.record('email_auth_code_verified', {
      actorUsername: pending.account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    issueFullSession(freshAccount, req, res);
  });

  router.post('/auth/2fa/resend', async (req, res) => {
    const pending = resolvePendingToken(req, ['email']);
    if (!pending.ok) {
      return sendApiError(res, pending.status, pending.message, pending.code);
    }
    const mfaEmail = getEmailMfaAddress(pending.account);
    if (!mfaEmail) {
      return sendApiError(res, 409, 'Bu hesap icin kullanilabilir bir e-posta bulunamadi.', 'missing_mfa_email');
    }
    const attempt = emailAuthResendLimiter.consume(`${pending.account.username}:${hashBucketValue(req.ip)}`);
    if (!attempt.ok) {
      return sendApiError(
        res,
        429,
        'Cok sik kod istedin. Biraz sonra tekrar dene.',
        'too_many_email_code_resends',
      );
    }
    try {
      await dispatchEmailAuthCode({
        account: pending.account,
        email: mfaEmail,
        challengeId: pending.pending.tokenId,
        req,
        reason: 'resend',
      });
    } catch (error) {
      audit.record('email_auth_code_send_failed', {
        actorUsername: pending.account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: error?.message || 'unknown', flow: 'resend' },
      });
      logger.warn('email_auth_code_send_failed', {
        username: pending.account.username,
        error: error?.message || String(error),
        flow: 'resend',
      });
      return sendApiError(res, 503, 'Kod e-postasi su an gonderilemedi.', 'email_code_send_failed');
    }
    res.json({
      ok: true,
      email_hint: maskEmailAddress(mfaEmail),
    });
  });

  router.post('/auth/refresh', refreshRateLimiter, (req, res) => {
    const result = sessions.refreshSession({
      refreshToken: req.body?.refresh_token,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    if (!result.ok) {
      const status = ['refresh_reuse_detected', 'stale_session', 'account_unavailable'].includes(result.code)
        ? 401
        : 400;
      return sendApiError(res, status, result.message, result.code);
    }

    audit.record('refresh_ok', {
      actorUsername: result.user.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      user: result.user,
    });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    const account = db.getAccount(req.auth.username);
    res.json({
      user: account ? sessions.buildUserPayload(account) : {
        username: req.auth.username,
        displayName: req.auth.displayName || req.auth.username,
        role: req.auth.role || 'user',
      },
    });
  });

  router.post('/auth/change-display-name', requireAuth, (req, res) => {
    const displayNameCheck = validateDisplayName(req.body?.display_name);
    if (!displayNameCheck.ok) {
      return sendApiError(res, 400, displayNameCheck.message, 'invalid_display_name');
    }

    db.updateAccountDisplayName(req.auth.username, displayNameCheck.displayName);
    const account = db.getAccount(req.auth.username);
    audit.record('display_name_changed', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { displayName: displayNameCheck.displayName },
    });

    res.json({
      user: sessions.buildUserPayload(account),
    });
  });

  router.post('/auth/change-password', requireAuth, (req, res) => {
    const account = db.getAccount(req.auth.username);
    if (!account) {
      return sendApiError(res, 401, 'Oturumun geçersiz. Tekrar giriş yap.', 'missing_account');
    }
    if (typeof req.body?.current_password !== 'string' || !req.body.current_password) {
      return sendApiError(res, 400, 'Mevcut şifre gerekli.', 'invalid_password');
    }

    const currentPasswordCheck = verifyPassword(req.body.current_password, account.password_hash);
    if (!currentPasswordCheck.ok) {
      audit.record('password_change_fail', {
        actorUsername: req.auth.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'current_password_mismatch' },
      });
      return sendApiError(res, 401, 'Mevcut şifre yanlış.', 'invalid_credentials');
    }

    const nextPasswordCheck = validatePassword(req.body?.new_password, {
      username: account.username,
      displayName: account.display_name || account.username,
    });
    if (!nextPasswordCheck.ok) {
      return sendApiError(res, 400, nextPasswordCheck.message, 'weak_password');
    }
    if (verifyPassword(req.body.new_password, account.password_hash).ok) {
      return sendApiError(res, 400, 'Yeni şifre mevcut şifreyle aynı olamaz.', 'password_reused');
    }

    db.updateAccountPasswordHash(account.username, hashPassword(req.body.new_password));
    sessions.revokeAllSessionsForUser({
      username: account.username,
      accessTokenId: req.auth.tokenId,
      accessTokenExpiresAt: req.auth.expiresAt,
    });
    audit.record('password_change', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    forceDisconnectUser(account.username, 'password_changed', 'Şifren değişti. Tekrar giriş yap.');
    logger.info('account_password_changed', { username: account.username });
    res.status(204).end();
  });

  router.post('/auth/change-email', requireAuth, async (req, res) => {
    if (!isEmailFlowEnabled()) {
      return sendApiError(res, 503, 'E-posta servisi su an kullanilamiyor.', 'email_unavailable');
    }

    const account = db.getAccount(req.auth.username);
    if (!account) {
      return sendApiError(res, 401, 'Oturumun geçersiz. Tekrar giriş yap.', 'missing_account');
    }
    if (typeof req.body?.current_password !== 'string' || !req.body.current_password) {
      return sendApiError(res, 400, 'Mevcut şifre gerekli.', 'invalid_password');
    }

    const currentPasswordCheck = verifyPassword(req.body.current_password, account.password_hash);
    if (!currentPasswordCheck.ok) {
      audit.record('email_change_fail', {
        actorUsername: req.auth.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'current_password_mismatch' },
      });
      return sendApiError(res, 401, 'Mevcut şifre yanlış.', 'invalid_credentials');
    }

    const emailCheck = validateEmail(req.body?.new_email);
    if (!emailCheck.ok) {
      return sendApiError(res, 400, emailCheck.message, 'invalid_email');
    }
    if ((account.email || '').toLowerCase() === emailCheck.email && !account.email_pending) {
      return res.json({ user: sessions.buildUserPayload(account) });
    }

    const existingOwner = findEmailOwner(emailCheck.email, account.username);
    if (existingOwner) {
      return sendApiError(res, 409, 'Bu e-posta kullanilamiyor.', 'email_unavailable');
    }

    const pendingToken = buildOpaqueToken(account.username);
    const pendingExpiresAt = Date.now() + config.emailVerificationTokenTtlMs;
    db.setAccountPendingEmail(account.username, emailCheck.email, pendingToken.tokenHash, pendingExpiresAt);

    let warning = null;
    try {
      await dispatchVerificationEmail({
        account,
        email: emailCheck.email,
        token: pendingToken.token,
        req,
      });
    } catch (error) {
      warning = 'Dogrulama e-postasi su an gonderilemedi. Biraz sonra tekrar dene.';
      audit.record('email_verification_send_failed', {
        actorUsername: account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: error?.message || 'unknown', phase: 'change_email' },
      });
    }

    if (account.email) {
      try {
        await emailService.sendEmailChangeNotification({
          to: account.email,
          displayName: account.display_name || account.username,
          requestedFrom: `${req.ip || 'bilinmeyen ip'} • ${req.get('user-agent') || 'bilinmeyen cihaz'}`,
          revokeUrl: '',
        });
      } catch (error) {
        logger.warn('email_change_notice_failed', {
          username: account.username,
          error: error?.message || String(error),
        });
      }
    }

    const freshAccount = db.getAccount(account.username);
    audit.record('email_change_requested', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { emailPending: emailCheck.email },
    });

    res.status(warning ? 202 : 200).json({
      user: sessions.buildUserPayload(freshAccount),
      warning,
    });
  });

  router.post('/auth/change-email/confirm', (req, res) => {
    const verification = verifyStoredOpaqueToken({
      wireToken: req.body?.token,
      expectedHash: null,
    });
    const username = verification.parsed?.tokenId;
    const account = username ? db.getAccount(username) : null;
    const verifiedToken = verifyStoredOpaqueToken({
      wireToken: req.body?.token,
      expectedHash: account?.email_pending_token_hash || null,
    });

    if (!account || !account.email_pending || !verifiedToken.ok || !verifiedToken.parsed) {
      return sendApiError(res, 400, 'Dogrulama baglantisi gecersiz.', 'invalid_or_expired_token');
    }
    if (!account.email_pending_expires_at || account.email_pending_expires_at <= Date.now()) {
      return sendApiError(res, 400, 'Dogrulama baglantisinin suresi dolmus.', 'invalid_or_expired_token');
    }

    const existingOwner = db.getAccountByEmail(account.email_pending);
    if (existingOwner && existingOwner.username !== account.username) {
      return sendApiError(res, 409, 'Bu e-posta artik kullanilamiyor.', 'email_unavailable');
    }

    db.confirmAccountPendingEmail(account.username, Date.now());
    const freshAccount = db.getAccount(account.username);
    audit.record('email_changed', {
      actorUsername: account.username,
      targetUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { email: freshAccount?.email || null },
    });
    res.json({
      message: 'E-posta adresin dogrulandi.',
      user: freshAccount ? sessions.buildUserPayload(freshAccount) : null,
    });
  });

  router.post('/auth/forgot-password', async (req, res) => {
    if (!isEmailFlowEnabled()) {
      return sendApiError(res, 503, 'Sifre sifirlama su an kullanilamiyor.', 'email_unavailable');
    }

    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
    if (!rawEmail.trim()) {
      return sendApiError(res, 400, 'E-posta gerekli.', 'invalid_email');
    }

    const normalizedEmail = normalizeEmail(rawEmail);
    const now = Date.now();
    const emailLimit = forgotEmailLimiter.consume(hashBucketValue(normalizedEmail), now);
    const ipLimit = forgotIpLimiter.consume(req.ip || 'unknown', now);
    if (!emailLimit.ok || !ipLimit.ok) {
      return sendApiError(
        res,
        429,
        'Cok fazla sifre sifirlama istegi gonderildi. Lutfen biraz bekle.',
        'too_many_reset_requests',
      );
    }

    const emailCheck = validateEmail(normalizedEmail);
    const account = emailCheck.ok ? db.getAccountByEmail(emailCheck.email) : null;
    if (!account || !account.email_verified_at) {
      audit.record('reset_requested_unknown_email', {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { email: emailCheck.ok ? emailCheck.email : normalizedEmail || null },
      });
      return res.status(204).end();
    }

    const activeTokens = db.listActivePasswordResetTokens(account.username, now);
    while (activeTokens.length >= 3) {
      const oldest = activeTokens.shift();
      db.markPasswordResetTokenUsed(oldest.token_id, now);
    }

    const tokenId = crypto.randomUUID();
    const resetToken = buildOpaqueToken(tokenId);
    db.insertPasswordResetToken({
      tokenId,
      tokenHash: resetToken.tokenHash,
      accountUsername: account.username,
      createdAt: now,
      expiresAt: now + config.passwordResetTokenTtlMs,
      requestIp: req.ip || null,
    });

    try {
      await emailService.sendPasswordReset({
        to: account.email,
        displayName: account.display_name || account.username,
        resetUrl: `${getPublicAppUrl(req)}/reset-password?token=${encodeURIComponent(resetToken.token)}`,
        expiresInMin: Math.round(config.passwordResetTokenTtlMs / 60_000),
      });
    } catch (error) {
      db.markPasswordResetTokenUsed(tokenId, now);
      audit.record('password_reset_send_failed', {
        actorUsername: account.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: error?.message || 'unknown' },
      });
      return sendApiError(res, 503, 'Sifre sifirlama e-postasi gonderilemedi.', 'email_send_failed');
    }

    audit.record('password_reset_requested', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(204).end();
  });

  router.post('/auth/reset-password', (req, res) => {
    const ipLimit = resetUseIpLimiter.consume(req.ip || 'unknown', Date.now());
    if (!ipLimit.ok) {
      return sendApiError(
        res,
        429,
        'Cok fazla sifre yenileme denemesi yapildi. Lutfen biraz bekle.',
        'too_many_reset_attempts',
      );
    }

    const tokenCheck = verifyStoredOpaqueToken({
      wireToken: req.body?.token,
      expectedHash: null,
    });
    const tokenId = tokenCheck.parsed?.tokenId || null;
    const row = tokenId ? db.getPasswordResetToken(tokenId) : null;
    const verified = verifyStoredOpaqueToken({
      wireToken: req.body?.token,
      expectedHash: row?.token_hash || null,
    });

    if (!row || !verified.ok || !verified.parsed) {
      return sendApiError(res, 400, 'Sifirlama baglantisi gecersiz ya da suresi dolmus.', 'used_or_expired');
    }
    if (row.used_at || row.expires_at <= Date.now()) {
      return sendApiError(res, 400, 'Sifirlama baglantisi gecersiz ya da suresi dolmus.', 'used_or_expired');
    }

    const account = db.getAccount(row.account_username);
    if (!account) {
      return sendApiError(res, 400, 'Sifirlama baglantisi gecersiz ya da suresi dolmus.', 'used_or_expired');
    }

    const nextPasswordCheck = validatePassword(req.body?.new_password, {
      username: account.username,
      displayName: account.display_name || account.username,
    });
    if (!nextPasswordCheck.ok) {
      return sendApiError(res, 400, nextPasswordCheck.message, 'weak_password');
    }
    if (verifyPassword(req.body.new_password, account.password_hash).ok) {
      return sendApiError(res, 400, 'Yeni şifre mevcut şifreyle aynı olamaz.', 'password_reused');
    }

    db.completePasswordReset({
      tokenId: row.token_id,
      username: account.username,
      passwordHash: hashPassword(req.body.new_password),
      usedAt: Date.now(),
    });
    audit.record('password_reset_used', {
      actorUsername: account.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { tokenId: row.token_id },
    });
    forceDisconnectUser(account.username, 'password_reset', 'Sifren sifirlandi. Tekrar giris yap.');
    res.json({ ok: true, message: 'Sifren yenilendi. Simdi giris yapabilirsin.' });
  });

  router.get('/auth/sessions', requireAuth, (req, res) => {
    const currentRefreshTokenId = sessions.getRefreshTokenIdForAccessToken(req.auth.tokenId);
    const items = db.listActiveRefreshTokens(req.auth.username).map((row) => ({
      id: row.token_id,
      device_label: row.device_label || row.user_agent || 'Bilinmeyen cihaz',
      ip: row.ip || null,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      is_current: currentRefreshTokenId === row.token_id,
    }));
    res.json({ items });
  });

  router.delete('/auth/sessions/:id', requireAuth, (req, res) => {
    const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!sessionId) {
      return sendApiError(res, 400, 'Geçersiz oturum kimliği.', 'invalid_session_id');
    }

    const row = db.getRefreshToken(sessionId);
    if (!row || row.account_username !== req.auth.username) {
      return sendApiError(res, 404, 'Oturum bulunamadı.', 'session_not_found');
    }

    const isCurrentSession = sessions.getRefreshTokenIdForAccessToken(req.auth.tokenId) === sessionId;
    db.revokeRefreshToken(sessionId);
    if (isCurrentSession) {
      db.revokeAccessToken(req.auth.tokenId, req.auth.expiresAt);
      sessions.forgetAccessToken(req.auth.tokenId);
    }

    disconnectSocketsMatching(
      (socket) => sessions.getRefreshTokenIdForAccessToken(socket.data?.auth?.tokenId) === sessionId,
      'session_revoked',
      'Bu oturum kapatıldı. Tekrar giriş yap.',
    );
    audit.record('session_revoked', {
      actorUsername: req.auth.username,
      targetUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { sessionId, isCurrentSession },
    });
    res.status(204).end();
  });

  router.post('/auth/sessions/logout-all', requireAuth, (req, res) => {
    sessions.revokeAllSessionsForUser({
      username: req.auth.username,
      accessTokenId: req.auth.tokenId,
      accessTokenExpiresAt: req.auth.expiresAt,
    });
    audit.record('sessions_logout_all', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    forceDisconnectUser(req.auth.username, 'sessions_revoked', 'Tüm oturumların kapatıldı. Tekrar giriş yap.');
    res.status(204).end();
  });

  router.post('/auth/account/delete', requireAuth, (req, res) => {
    const account = db.getAccount(req.auth.username);
    if (!account) {
      return sendApiError(res, 401, 'Oturumun geçersiz. Tekrar giriş yap.', 'missing_account');
    }
    if (typeof req.body?.current_password !== 'string' || !req.body.current_password) {
      return sendApiError(res, 400, 'Mevcut şifre gerekli.', 'invalid_password');
    }
    if (!verifyPassword(req.body.current_password, account.password_hash).ok) {
      audit.record('account_delete_fail', {
        actorUsername: req.auth.username,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { reason: 'current_password_mismatch' },
      });
      return sendApiError(res, 401, 'Mevcut şifre yanlış.', 'invalid_credentials');
    }

    const pendingDeleteAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
    db.scheduleAccountDelete(req.auth.username, pendingDeleteAt);
    sessions.revokeAllSessionsForUser({
      username: req.auth.username,
      accessTokenId: req.auth.tokenId,
      accessTokenExpiresAt: req.auth.expiresAt,
    });
    audit.record('account_delete_requested', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { pendingDeleteAt },
    });
    forceDisconnectUser(req.auth.username, 'account_pending_delete', 'Hesabın silinmek üzere işaretlendi. Tekrar giriş yap.');
    res.status(204).end();
  });

  router.post('/auth/account/restore', requireAuth, (req, res) => {
    const account = db.getAccount(req.auth.username);
    if (!account) {
      return sendApiError(res, 401, 'Oturumun geçersiz. Tekrar giriş yap.', 'missing_account');
    }
    if (!account.pending_delete_at) {
      return res.status(204).end();
    }

    db.clearPendingAccountDelete(req.auth.username);
    const freshAccount = db.getAccount(req.auth.username);
    audit.record('account_restore', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ user: sessions.buildUserPayload(freshAccount) });
  });

  router.post('/auth/logout', requireAuth, (req, res) => {
    sessions.revokeSession({
      username: req.auth.username,
      accessTokenId: req.auth.tokenId,
      accessTokenExpiresAt: req.auth.expiresAt,
      refreshToken: req.body?.refresh_token || null,
    });
    audit.record('account_logged_out', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { tokenId: req.auth.tokenId },
    });
    logger.info('account_logged_out', { username: req.auth.username, tokenId: req.auth.tokenId });
    res.status(204).end();
  });

  router.get('/admin/invites', requireAuth, requireAdmin, (_req, res) => {
    const items = db.listInvites().map((invite) => ({
      id: invite.invite_id,
      label: invite.label || '',
      created_by: invite.created_by,
      max_uses: invite.max_uses,
      uses_remaining: invite.uses_remaining,
      expires_at: invite.expires_at,
      created_at: invite.created_at,
      revoked_at: invite.revoked_at,
    }));
    res.json({ items });
  });

  router.post('/admin/invites', requireAuth, requireAdmin, (req, res) => {
    const ttlHours = Number(req.body?.ttl_hours);
    const maxUses = Number(req.body?.max_uses);
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 80) : '';
    const expiresAt = Number.isFinite(ttlHours) && ttlHours > 0
      ? Date.now() + (ttlHours * 60 * 60 * 1000)
      : null;
    const normalizedMaxUses = Number.isFinite(maxUses) && maxUses > 0 ? Math.min(Math.floor(maxUses), 500) : 1;
    const inviteId = crypto.randomUUID();
    const code = generateInviteCode();
    db.createInvite({
      inviteId,
      code,
      label: label || null,
      createdBy: req.auth.username,
      maxUses: normalizedMaxUses,
      usesRemaining: normalizedMaxUses,
      expiresAt,
      createdAt: Date.now(),
    });
    audit.record('invite_created', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { inviteId, maxUses: normalizedMaxUses, expiresAt, label: label || null },
    });
    res.status(201).json({ id: inviteId, code });
  });

  router.delete('/admin/invites/:id', requireAuth, requireAdmin, (req, res) => {
    const invite = db.getInviteById(req.params.id);
    if (!invite) {
      return sendApiError(res, 404, 'Davet bulunamadi.', 'invite_not_found');
    }
    db.revokeInvite(invite.invite_id, Date.now());
    audit.record('invite_revoked', {
      actorUsername: req.auth.username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { inviteId: invite.invite_id },
    });
    res.status(204).end();
  });

  router.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const disabled = typeof req.query.disabled === 'string' ? req.query.disabled.trim().toLowerCase() : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
    const items = db.listAccounts({ query, disabled, limit }).map((account) => ({
      username: account.username,
      display_name: account.display_name || account.username,
      email: account.email || null,
      role: account.role || 'user',
      mfa_enabled_at: account.email_verified_at || null,
      disabled_at: account.disabled_at || null,
      pending_delete_at: account.pending_delete_at || null,
      created_at: account.created_at,
      last_login_at: account.last_login_at,
    }));
    res.json({ items });
  });

  router.post('/admin/users/:username/disable', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    if (!username) return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    const account = db.getAccount(username);
    if (!account) return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');

    const disabledAt = Date.now();
    db.setAccountDisabledAt(username, disabledAt);
    sessions.revokeAllSessionsForUser({ username, now: disabledAt });
    forceDisconnectUser(username, 'account_disabled', 'Bu hesap devre disi birakildi.');
    audit.record('admin_user_disabled', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ user: sessions.buildUserPayload(db.getAccount(username)) });
  });

  router.post('/admin/users/:username/enable', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    if (!username) return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    const account = db.getAccount(username);
    if (!account) return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');

    db.setAccountDisabledAt(username, null);
    audit.record('admin_user_enabled', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ user: sessions.buildUserPayload(db.getAccount(username)) });
  });

  router.post('/admin/users/:username/role', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'user' ? 'user' : null;
    if (!username) return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    if (!role) return sendApiError(res, 400, 'Gecersiz rol.', 'invalid_role');
    const account = db.getAccount(username);
    if (!account) return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');

    db.setAccountRole(username, role);
    sessions.revokeAllSessionsForUser({ username, now: Date.now() });
    forceDisconnectUser(username, 'role_changed', 'Hesap yetkin guncellendi. Tekrar giris yap.');
    audit.record('role_change', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { role },
    });
    res.json({ user: sessions.buildUserPayload(db.getAccount(username)) });
  });

  router.post('/admin/users/:username/logout-all', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    if (!username) return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    const account = db.getAccount(username);
    if (!account) return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');

    sessions.revokeAllSessionsForUser({ username, now: Date.now() });
    forceDisconnectUser(username, 'admin_logout_all', 'Tum oturumlarin yonetici tarafindan kapatildi.');
    audit.record('admin_sessions_logout_all', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(204).end();
  });

  router.delete('/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    const phrase = typeof req.body?.confirmation_phrase === 'string'
      ? req.body.confirmation_phrase.trim().toUpperCase()
      : '';
    if (!username) return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    if (phrase !== 'HESABIMI SIL') {
      return sendApiError(res, 400, 'Onay metni gecersiz.', 'invalid_confirmation_phrase');
    }
    const account = db.getAccount(username);
    if (!account) return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');

    const pendingDeleteAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
    db.scheduleAccountDelete(username, pendingDeleteAt);
    sessions.revokeAllSessionsForUser({ username, now: Date.now() });
    forceDisconnectUser(username, 'account_pending_delete', 'Hesabin silinmek uzere isaretlendi.');
    audit.record('admin_account_delete_requested', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { pendingDeleteAt },
    });
    res.status(204).end();
  });

  router.get('/admin/audit-log', requireAuth, requireAdmin, (req, res) => {
    const event = typeof req.query.event === 'string' ? req.query.event.trim() : '';
    const actor = typeof req.query.actor === 'string' ? req.query.actor.trim() : '';
    const since = Number(req.query.since);
    const until = Number(req.query.until);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const items = db.getAuditLogFiltered({
      event,
      actor,
      since: Number.isFinite(since) ? since : null,
      until: Number.isFinite(until) ? until : null,
      limit,
    });
    res.json({ items });
  });

  router.post('/admin/users/:username/email-set', requireAuth, requireAdmin, (req, res) => {
    const username = canonicalizeUsername(req.params.username);
    if (!username) {
      return sendApiError(res, 400, 'Gecersiz kullanici adi.', 'invalid_username');
    }

    const emailCheck = validateEmail(req.body?.email);
    if (!emailCheck.ok) {
      return sendApiError(res, 400, emailCheck.message, 'invalid_email');
    }

    const existingOwner = findEmailOwner(emailCheck.email, username);
    if (existingOwner) {
      return sendApiError(res, 409, 'Bu e-posta kullanilamiyor.', 'email_unavailable');
    }

    const account = db.getAccount(username);
    if (!account) {
      return sendApiError(res, 404, 'Kullanici bulunamadi.', 'missing_account');
    }

    db.setAccountEmail(username, emailCheck.email, Date.now());
    audit.record('admin_email_set', {
      actorUsername: req.auth.username,
      targetUsername: username,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { email: emailCheck.email },
    });
    res.json({ user: sessions.buildUserPayload(db.getAccount(username)) });
  });

  return router;
}

module.exports = {
  createAuthRouter,
  timingSafeStringEqual,
};
