// routes/emailAuth.js
// Gmail & Outlook OAuth + email sending for Pulse surveys

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase (service role for token storage) ───────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Google OAuth2 Client ────────────────────────────────────────────────────
const getGoogleOAuthClient = () =>
  new google.auth.OAuth2(
    '1085556759063-c67d734omncufsquhrjo9tg8bgmqbmgo.apps.googleusercontent.com',
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.API_BASE_URL}/api/email/gmail/callback`
  );

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// ─── Microsoft OAuth config ──────────────────────────────────────────────────
const OUTLOOK_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const OUTLOOK_SCOPES = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access';
const OUTLOOK_REDIRECT = `${process.env.API_BASE_URL}/api/email/outlook/callback`;

// ─── Auth middleware ─────────────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  if (req.headers['x-pulse-secret'] === process.env.PULSE_API_SECRET) {
    req.user = { id: req.headers['x-user-id'] || 'internal' };
    return next();
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
};
// ═════════════════════════════════════════════════════════════════════════════
// GMAIL ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/email/gmail/auth
// Returns the Google OAuth URL; frontend opens it in a popup
router.get('/gmail/auth', (req, res) => {
  console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);
  const oauth2Client = getGoogleOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    prompt: 'consent',                         // force refresh_token every time
    state: 'user',                        // carry user_id through the flow
  });
  res.json({ url });
});

// GET /api/email/gmail/callback
// Google redirects here after user grants access
router.get('/gmail/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=access_denied`);
  }

  try {
    const oauth2Client = getGoogleOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Upsert into Supabase
    const { error: dbError } = await supabase
      .from('email_accounts')
      .upsert({
        user_id: userId,
        provider: 'gmail',
        email: profile.email,
        display_name: profile.name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        scope: tokens.scope,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,email',
        ignoreDuplicates: false,
      });

    if (dbError) throw dbError;

    res.redirect(`${process.env.FRONTEND_URL}/settings/email?connected=gmail&email=${encodeURIComponent(profile.email)}`);
  } catch (err) {
    console.error('Gmail callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=gmail_failed`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// OUTLOOK ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/email/outlook/auth
router.get('/outlook/auth', requireAuth, (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OUTLOOK_REDIRECT,
    scope: OUTLOOK_SCOPES,
    response_mode: 'query',
    state: req.user.id,
    prompt: 'consent',
  });
  res.json({ url: `${OUTLOOK_AUTH_URL}?${params}` });
});

// GET /api/email/outlook/callback
router.get('/outlook/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=access_denied`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(OUTLOOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: OUTLOOK_REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description);

    // Fetch user profile from Microsoft Graph
    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();

    const email = profile.mail || profile.userPrincipalName;
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase
      .from('email_accounts')
      .upsert({
        user_id: userId,
        provider: 'outlook',
        email,
        display_name: profile.displayName,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expires_at: expiresAt,
        scope: tokens.scope,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,email',
        ignoreDuplicates: false,
      });

    res.redirect(`${process.env.FRONTEND_URL}/settings/email?connected=outlook&email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('Outlook callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=outlook_failed`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/email/accounts
router.get('/accounts', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, provider, email, display_name, is_primary, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data });
});

// PATCH /api/email/accounts/:id/set-primary
router.patch('/accounts/:id/set-primary', requireAuth, async (req, res) => {
  const { id } = req.params;

  // Unset all primaries first
  await supabase
    .from('email_accounts')
    .update({ is_primary: false })
    .eq('user_id', req.user.id);

  const { error } = await supabase
    .from('email_accounts')
    .update({ is_primary: true })
    .eq('id', id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE /api/email/accounts/:id
router.delete('/accounts/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('email_accounts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL SENDING
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/email/send
// Body: { accountId, to: [emails], subject, htmlBody, surveyId? }
router.post('/send', requireAuth, async (req, res) => {
  const { accountId, to, subject, htmlBody, surveyId } = req.body;

  if (!accountId || !to?.length || !subject || !htmlBody) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Fetch account with tokens
  const { data: account, error: fetchErr } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', accountId)
    .eq('user_id', req.user.id)
    .single();

  if (fetchErr || !account) {
    return res.status(404).json({ error: 'Email account not found' });
  }

  try {
    // Refresh token if expired
    const freshAccount = await refreshTokenIfNeeded(account);

    const results = [];
    for (const recipient of to) {
      try {
        if (freshAccount.provider === 'gmail') {
          await sendViaGmail(freshAccount, recipient, subject, htmlBody);
        } else {
          await sendViaOutlook(freshAccount, recipient, subject, htmlBody);
        }
        results.push({ email: recipient, status: 'sent' });

        // Log to survey_email_sends if surveyId provided
        if (surveyId) {
          await supabase.from('survey_email_sends').insert({
            survey_id: surveyId,
            email_account_id: accountId,
            recipient_email: recipient,
            subject,
            status: 'sent',
            sent_at: new Date().toISOString(),
          });
        }
      } catch (sendErr) {
        results.push({ email: recipient, status: 'failed', error: sendErr.message });
        if (surveyId) {
          await supabase.from('survey_email_sends').insert({
            survey_id: surveyId,
            email_account_id: accountId,
            recipient_email: recipient,
            subject,
            status: 'failed',
            error_message: sendErr.message,
          });
        }
      }
    }

    const allFailed = results.every(r => r.status === 'failed');
    res.status(allFailed ? 500 : 200).json({ results });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail send helper ────────────────────────────────────────────────────────
async function sendViaGmail(account, to, subject, htmlBody) {
  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // RFC 2822 raw message
  const raw = makeRawEmail(account.email, account.display_name, to, subject, htmlBody);

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

// ─── Outlook send helper ──────────────────────────────────────────────────────
async function sendViaOutlook(account, to, subject, htmlBody) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: [{ emailAddress: { address: to } }],
        from: {
          emailAddress: {
            address: account.email,
            name: account.display_name || account.email,
          },
        },
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Outlook send failed');
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────
async function refreshTokenIfNeeded(account) {
  const now = Date.now();
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : null;

  // Refresh if within 5 minutes of expiry
  if (!expiresAt || expiresAt - now > 5 * 60 * 1000) return account;

  if (account.provider === 'gmail') {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: account.refresh_token });
    const { credentials } = await oauth2Client.refreshAccessToken();

    await supabase.from('email_accounts').update({
      access_token: credentials.access_token,
      token_expires_at: credentials.expiry_date
        ? new Date(credentials.expiry_date).toISOString()
        : null,
    }).eq('id', account.id);

    return { ...account, access_token: credentials.access_token };
  }

  if (account.provider === 'outlook') {
    const tokenRes = await fetch(OUTLOOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error('Failed to refresh Outlook token');

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await supabase.from('email_accounts').update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || account.refresh_token,
      token_expires_at: expiresAt,
    }).eq('id', account.id);

    return { ...account, access_token: tokens.access_token };
  }

  return account;
}

// ─── RFC 2822 email builder ───────────────────────────────────────────────────
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

module.exports = router;
