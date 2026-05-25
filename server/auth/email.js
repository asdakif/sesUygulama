'use strict';

const NOOP_OUTBOX = [];

function createEmailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureUrl(url, message) {
  if (typeof url !== 'string' || !url.trim()) {
    throw createEmailError('email_unavailable', message);
  }
  return url.trim();
}

function buildTextBody(lines) {
  return lines.filter(Boolean).join('\n\n');
}

function createNoopAdapter({ logger }) {
  async function capture(kind, payload) {
    NOOP_OUTBOX.push({
      kind,
      ...payload,
      sentAt: Date.now(),
    });
    logger?.info?.('email_noop_captured', {
      kind,
      to: payload.to,
      subject: payload.subject,
    });
    return { id: `noop-${NOOP_OUTBOX.length}` };
  }

  return {
    mode: 'noop',
    available: true,
    async sendPasswordReset({ to, displayName, resetUrl, expiresInMin }) {
      return capture('password_reset', {
        to,
        displayName,
        resetUrl,
        expiresInMin,
        subject: 'SesApp sifre sifirlama baglantisi',
      });
    },
    async sendEmailVerification({ to, displayName, verifyUrl, expiresInMin }) {
      return capture('email_verification', {
        to,
        displayName,
        verifyUrl,
        expiresInMin,
        subject: 'SesApp e-posta dogrulama baglantisi',
      });
    },
    async sendEmailChangeNotification({ to, displayName, requestedFrom, revokeUrl = '' }) {
      return capture('email_change_notice', {
        to,
        displayName,
        requestedFrom,
        revokeUrl,
        subject: 'SesApp e-posta degisikligi bildirimi',
      });
    },
  };
}

function createResendAdapter({ config, logger }) {
  const available = Boolean(config.resendApiKey && config.emailFrom);

  async function send({ to, subject, text }) {
    if (!available) {
      throw createEmailError('email_unavailable', 'E-posta servisi henuz yapilandirilmamis.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [to],
        subject,
        text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger?.error?.('email_resend_failed', {
        status: response.status,
        body,
      });
      throw createEmailError('email_send_failed', 'E-posta gonderilemedi.');
    }

    return response.json().catch(() => ({ id: null }));
  }

  return {
    mode: 'resend',
    available,
    async sendPasswordReset({ to, displayName, resetUrl, expiresInMin }) {
      return send({
        to,
        subject: 'SesApp sifre sifirlama baglantisi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `Sifreni yenilemek icin bu baglantiyi kullan: ${ensureUrl(resetUrl, 'Sifirlama baglantisi olusturulamadi.')}`,
          `Bu baglanti ${expiresInMin} dakika icinde sona erecek.`,
          'Bu istegi sen yapmadiysan bu e-postayi yok sayabilirsin.',
        ]),
      });
    },
    async sendEmailVerification({ to, displayName, verifyUrl, expiresInMin }) {
      return send({
        to,
        subject: 'SesApp e-posta dogrulama baglantisi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `E-postani dogrulamak icin bu baglantiyi ac: ${ensureUrl(verifyUrl, 'Dogrulama baglantisi olusturulamadi.')}`,
          `Bu baglanti ${expiresInMin} dakika icinde sona erecek.`,
        ]),
      });
    },
    async sendEmailChangeNotification({ to, displayName, requestedFrom, revokeUrl = '' }) {
      return send({
        to,
        subject: 'SesApp e-posta degisikligi bildirimi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `Hesabin icin yeni bir e-posta degisikligi istendi. Istek kaynagi: ${requestedFrom || 'bilinmiyor'}.`,
          revokeUrl ? `Bunu sen yapmadiysan su baglantiyi ac: ${revokeUrl}` : 'Bunu sen yapmadiysan hemen sifreni degistir ve oturumlarini kapat.',
        ]),
      });
    },
  };
}

function createSmtpAdapter({ config, logger }) {
  let transporter = null;
  try {
    const nodemailer = require('nodemailer');
    transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  } catch (error) {
    logger?.warn?.('email_smtp_dependency_missing', {
      error: error?.message || String(error),
    });
  }

  const available = Boolean(transporter && config.emailFrom);

  async function send({ to, subject, text }) {
    if (!available) {
      throw createEmailError('email_unavailable', 'SMTP e-posta servisi henuz kullanilabilir degil.');
    }
    return transporter.sendMail({
      from: config.emailFrom,
      to,
      subject,
      text,
    });
  }

  return {
    mode: 'smtp',
    available,
    async sendPasswordReset({ to, displayName, resetUrl, expiresInMin }) {
      return send({
        to,
        subject: 'SesApp sifre sifirlama baglantisi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `Sifreni yenilemek icin bu baglantiyi kullan: ${ensureUrl(resetUrl, 'Sifirlama baglantisi olusturulamadi.')}`,
          `Bu baglanti ${expiresInMin} dakika icinde sona erecek.`,
        ]),
      });
    },
    async sendEmailVerification({ to, displayName, verifyUrl, expiresInMin }) {
      return send({
        to,
        subject: 'SesApp e-posta dogrulama baglantisi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `E-postani dogrulamak icin bu baglantiyi ac: ${ensureUrl(verifyUrl, 'Dogrulama baglantisi olusturulamadi.')}`,
          `Bu baglanti ${expiresInMin} dakika icinde sona erecek.`,
        ]),
      });
    },
    async sendEmailChangeNotification({ to, displayName, requestedFrom, revokeUrl = '' }) {
      return send({
        to,
        subject: 'SesApp e-posta degisikligi bildirimi',
        text: buildTextBody([
          `Merhaba ${displayName || 'SesApp kullanicisi'},`,
          `Hesabin icin yeni bir e-posta degisikligi istendi. Istek kaynagi: ${requestedFrom || 'bilinmiyor'}.`,
          revokeUrl ? `Bunu sen yapmadiysan su baglantiyi ac: ${revokeUrl}` : 'Bunu sen yapmadiysan hemen sifreni degistir ve oturumlarini kapat.',
        ]),
      });
    },
  };
}

function createUnavailableAdapter(provider) {
  return {
    mode: provider,
    available: false,
    async sendPasswordReset() {
      throw createEmailError('email_unavailable', 'E-posta servisi henuz yapilandirilmamis.');
    },
    async sendEmailVerification() {
      throw createEmailError('email_unavailable', 'E-posta servisi henuz yapilandirilmamis.');
    },
    async sendEmailChangeNotification() {
      throw createEmailError('email_unavailable', 'E-posta servisi henuz yapilandirilmamis.');
    },
  };
}

function createEmailService({ provider, config, logger }) {
  const selectedProvider = provider || (process.env.NODE_ENV === 'test' ? 'noop' : 'resend');
  switch (selectedProvider) {
    case 'noop':
      return createNoopAdapter({ logger });
    case 'resend':
      return createResendAdapter({ config, logger });
    case 'smtp':
      return createSmtpAdapter({ config, logger });
    default:
      return createUnavailableAdapter(selectedProvider);
  }
}

function getNoopOutbox() {
  return [...NOOP_OUTBOX];
}

function resetNoopOutbox() {
  NOOP_OUTBOX.length = 0;
}

module.exports = {
  createEmailError,
  createEmailService,
  getNoopOutbox,
  resetNoopOutbox,
};
