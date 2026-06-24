const nodemailer = require('nodemailer');
const axios = require('axios');

function getPasswordResetFromAddress() {
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM;
  if (from && !from.includes('<')) {
    return `EGWallet <${from}>`;
  }
  return from || 'EGWallet <egwallet.business@gmail.com>';
}

function getPasswordResetEmailMode() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return 'smtp';
  }
  const gmailUser = process.env.GMAIL_USER || process.env.SMTP_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
  if (gmailUser && gmailPass && (process.env.GMAIL_USER || process.env.SMTP_HOST === 'smtp.gmail.com')) {
    return 'gmail';
  }
  if (process.env.RESEND_API_KEY) {
    return 'resend';
  }
  return 'none';
}

function isPasswordResetEmailConfigured() {
  return getPasswordResetEmailMode() !== 'none';
}

function buildSmtpTransport() {
  const mode = getPasswordResetEmailMode();
  if (mode === 'smtp') {
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpSecure = process.env.SMTP_SECURE === 'true';
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      requireTLS: !smtpSecure,
      tls: { rejectUnauthorized: true },
    });
  }
  if (mode === 'gmail') {
    const user = process.env.GMAIL_USER || process.env.SMTP_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });
  }
  return null;
}

function buildPasswordResetEmailContent(resetLink) {
  const htmlEmail = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your EGWallet password</title></head>
<body style="margin:0;padding:0;background:#F5F7FA;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);" cellpadding="0" cellspacing="0">
        <tr><td style="background:#1565C0;padding:28px 32px;text-align:center;">
          <p style="margin:0;font-size:28px;">💳</p>
          <h1 style="margin:8px 0 0;color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:-0.3px;">EGWallet</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <h2 style="margin:0 0 12px;font-size:20px;color:#14171A;">Reset your password</h2>
          <p style="margin:0 0 24px;font-size:15px;color:#657786;line-height:1.6;">
            We received a request to reset the password for your EGWallet account.<br>
            Tap the button below — this link is valid for <strong>20 minutes</strong>.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${resetLink}" target="_blank"
                style="display:inline-block;background:#1565C0;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.2px;">
                Reset Password
              </a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:13px;color:#657786;">Or copy this link into your browser / app:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#1565C0;word-break:break-all;">${resetLink}</p>
          <hr style="border:none;border-top:1px solid #E1E8ED;margin:0 0 24px;">
          <p style="margin:0;font-size:13px;color:#AAB8C2;line-height:1.6;">
            If you didn't request a password reset, you can safely ignore this email — your password will not change.<br><br>
            — The EGWallet Team
          </p>
        </td></tr>
        <tr><td style="background:#F5F7FA;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#AAB8C2;">© 2026 EGWallet. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const plainText = `Reset your EGWallet password\n\nWe received a request to reset your password.\n\nReset link (valid 20 minutes):\n${resetLink}\n\nIf you didn't request this, ignore this email — your password won't change.\n\n— The EGWallet Team`;

  return {
    subject: 'Reset your EGWallet password',
    htmlEmail,
    plainText,
  };
}

async function sendPasswordResetEmail({ to, resetLink, userId, logger }) {
  const mode = getPasswordResetEmailMode();
  const { subject, htmlEmail, plainText } = buildPasswordResetEmailContent(resetLink);
  const fromAddress = getPasswordResetFromAddress();

  if (mode === 'smtp' || mode === 'gmail') {
    const transporter = buildSmtpTransport();
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text: plainText,
      html: htmlEmail,
    });
    const previewUrl = nodemailer.getTestMessageUrl(info) || null;
    logger.info('[Email] Password reset email sent', { userId, mode, messageId: info.messageId, previewUrl: previewUrl || undefined });
    return { ok: true, mode, previewUrl };
  }

  if (mode === 'resend') {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromAddress,
        to: [to],
        subject,
        html: htmlEmail,
        text: plainText,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    logger.info('[Email] Password reset email sent via Resend', { userId });
    return { ok: true, mode: 'resend' };
  }

  logger.warn(
    '[Email] Password reset email NOT sent — configure SMTP_HOST/SMTP_USER/SMTP_PASS, GMAIL_USER/GMAIL_APP_PASSWORD, or RESEND_API_KEY on Railway.',
    { userId }
  );
  return { ok: false, mode: 'none' };
}

module.exports = {
  isPasswordResetEmailConfigured,
  getPasswordResetEmailMode,
  sendPasswordResetEmail,
};
