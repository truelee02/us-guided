'use strict';
/*
 * Outgoing email — currently just password resets.
 *
 * With RESEND_API_KEY set, mail goes out through the Resend API
 * (MAIL_FROM chooses the sender; the domain must be verified in Resend,
 * or use their onboarding sender for testing).
 *
 * Without it, the message — including the reset link — is written to the
 * server log instead, where the site owner can read it in the host's log
 * viewer. That is a deliberate fallback for the owner-operated testing
 * phase, not a silent failure: sendPasswordReset reports what happened.
 */
async function sendPasswordReset(to, resetUrl) {
  const subject = 'Reset your Us, Guided password';
  const text = [
    'Hi,',
    '',
    'Someone (hopefully you) asked to reset the password for this email',
    'address on Us, Guided. Use this link within the next hour:',
    '',
    resetUrl,
    '',
    'If you didn\'t ask for this, you can ignore this email — your',
    'password has not been changed.',
    '',
    '— Us, Guided',
  ].join('\n');

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[mail] Email sending is not configured. Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, logged: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Us, Guided <onboarding@resend.dev>',
        to, subject, text,
      }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    return { sent: true };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    console.log(`[mail] Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, logged: true };
  }
}

module.exports = { sendPasswordReset };
