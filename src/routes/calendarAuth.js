// routes/calendarAuth.js
// Google Calendar OAuth flow.
// Tokens stored in email_accounts with provider = 'google_calendar'.
// Reuses the same HMAC state token pattern as emailAuth.js.

const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { requireApiKey, requireUser } = require('../middleware/auth');
const { encrypt } = require('../utils/crypto');
const { audit }   = require('../middleware/audit');
const { generateOAuthState, verifyOAuthState } = require('./emailAuth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

// Explicit env var (preferred) so there's no ambiguity about trailing slashes
// on API_BASE_URL. Set GOOGLE_CALENDAR_REDIRECT_URI in Railway to:
//   https://pulse-backend-production-485a.up.railway.app/api/calendar/callback
const CALENDAR_REDIRECT =
  process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
  `${process.env.API_BASE_URL}/api/calendar/callback`;

function getCalendarOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALENDAR_REDIRECT
  );
}

// ── GET /api/calendar/auth ────────────────────────────────────────────────────
// Returns the Google OAuth URL; frontend opens it in a popup or redirect
router.get('/auth', requireApiKey, requireUser, (req, res) => {
  console.log('[Calendar OAuth] redirect_uri =', CALENDAR_REDIRECT);
  const oauth2Client = getCalendarOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       CALENDAR_SCOPES,
    prompt:      'consent',
    state:       generateOAuthState(req.userId),
  });
  res.json({ url });
});

// ── GET /api/calendar/callback ────────────────────────────────────────────────
// Google redirects here after the user grants access — must stay public
const processedCodes = new Set();
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?error=access_denied`);
  }

  const userId = verifyOAuthState(state);
  if (!userId) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?error=invalid_state`);
  }

  if (!code || processedCodes.has(code)) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?error=duplicate`);
  }

  processedCodes.add(code);

  try {
    const oauth2Client = getCalendarOAuthClient();
    const { tokens }   = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const { error: dbError } = await supabase
      .from('email_accounts')
      .upsert({
        user_id:          userId,
        provider:         'google_calendar',
        email:            profile.email,
        display_name:     profile.name,
        access_token:     encrypt(tokens.access_token),
        refresh_token:    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        token_expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        scope:      tokens.scope,
        updated_at: new Date().toISOString(),
      }, {
        onConflict:       'user_id,provider,email',
        ignoreDuplicates: false,
      });

    if (dbError) throw dbError;

    audit(userId, 'calendar.token_stored', { meta: { provider: 'google_calendar' } });
    res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?connected=google_calendar&email=${encodeURIComponent(profile.email)}`);
  } catch (err) {
    console.error('[Calendar OAuth] callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /api/calendar/accounts ────────────────────────────────────────────────
router.get('/accounts', requireApiKey, requireUser, async (req, res) => {
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, email, display_name, created_at')
    .eq('user_id', req.userId)
    .eq('provider', 'google_calendar')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data });
});

// ── DELETE /api/calendar/accounts/:id ────────────────────────────────────────
router.delete('/accounts/:id', requireApiKey, requireUser, async (req, res) => {
  const { error } = await supabase
    .from('email_accounts')
    .delete()
    .eq('id',      req.params.id)
    .eq('user_id', req.userId)
    .eq('provider', 'google_calendar');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
module.exports.CALENDAR_REDIRECT       = CALENDAR_REDIRECT;
module.exports.getCalendarOAuthClient  = getCalendarOAuthClient;
