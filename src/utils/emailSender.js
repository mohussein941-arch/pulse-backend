// utils/emailSender.js
// Shared email sending — used by both emailAuth routes and the automation runner.
// Reads OAuth tokens from email_accounts table using the service role client.

const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function makeRawEmail(fromEmail, fromName, to, subject, htmlBody) {
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody,
  ].join('\r\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function refreshTokenIfNeeded(account) {
  const now       = Date.now();
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : null;

  if (!expiresAt || expiresAt - now > 5 * 60 * 1000) return account;

  if (account.provider === 'gmail') {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: account.refresh_token });
    const { credentials } = await oauth2Client.refreshAccessToken();

    await supabase.from('email_accounts').update({
      access_token:    credentials.access_token,
      token_expires_at: credentials.expiry_date
        ? new Date(credentials.expiry_date).toISOString()
        : null,
    }).eq('id', account.id);

    return { ...account, access_token: credentials.access_token };
  }

  if (account.provider === 'outlook') {
    const tokenRes = await fetch(OUTLOOK_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type:    'refresh_token',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error('Failed to refresh Outlook token');

    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await supabase.from('email_accounts').update({
      access_token:     tokens.access_token,
      refresh_token:    tokens.refresh_token || account.refresh_token,
      token_expires_at: newExpiresAt,
    }).eq('id', account.id);

    return { ...account, access_token: tokens.access_token };
  }

  return account;
}

async function sendViaGmail(account, to, subject, htmlBody) {
  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials({
    access_token:  account.access_token,
    refresh_token: account.refresh_token,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const raw   = makeRawEmail(account.email, account.display_name, to, subject, htmlBody);

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

async function sendViaOutlook(account, to, subject, htmlBody) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: [{ emailAddress: { address: to } }],
        from: { emailAddress: { address: account.email, name: account.display_name || account.email } },
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Outlook send failed');
  }
}

// ─── High-level helper used by the automation runner ────────────────────────
// Fetches the user's primary connected email account and sends.
// Returns true on success, false if no email account is connected.
async function sendAutomationEmail(userId, to, subject, htmlBody) {
  const { data: account } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('is_primary', true)
    .maybeSingle();

  if (!account) return false;

  const fresh = await refreshTokenIfNeeded(account);

  if (fresh.provider === 'gmail')   await sendViaGmail(fresh, to, subject, htmlBody);
  if (fresh.provider === 'outlook') await sendViaOutlook(fresh, to, subject, htmlBody);

  return true;
}

module.exports = {
  getGoogleOAuthClient,
  makeRawEmail,
  refreshTokenIfNeeded,
  sendViaGmail,
  sendViaOutlook,
  sendAutomationEmail,
};
