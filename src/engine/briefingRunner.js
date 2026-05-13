// engine/briefingRunner.js
// Generates daily briefings for all users whose schedule is due right now.
// Called by the hourly cron in server.js.

const { createClient }       = require('@supabase/supabase-js');
const { google }             = require('googleapis');
const { scanAccountSignals, scanTaskSignals, scanWins, currentScore, THRESHOLD, todayStr } = require('./briefingSignals');
const { buildBriefingEmail } = require('./briefingEmail');
const { decrypt, encrypt }   = require('../utils/crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:5174';

// ── Main entry point ──────────────────────────────────────────────────────────
async function runBriefingEngine() {
  console.log('[Briefing] Engine running...');
  const now = new Date();
  const currentHourUTC = now.getUTCHours();

  // Load all profiles with briefing enabled
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, full_name, briefing_config')
    .not('briefing_config', 'is', null);

  if (!profiles?.length) return;

  for (const profile of profiles) {
    try {
      await maybeGenerateBriefing(profile, currentHourUTC);
    } catch (err) {
      console.error(`[Briefing] Error for user ${profile.id}:`, err.message);
    }
  }
  console.log('[Briefing] Engine complete.');
}

async function maybeGenerateBriefing(profile, currentHourUTC) {
  const cfg = profile.briefing_config;
  if (!cfg?.enabled) return;

  // Convert user's preferred hour to UTC for comparison
  const tz = cfg.timezone || 'Asia/Dubai';
  const localHour = cfg.hour ?? 7;
  const utcHour = localHourToUTC(localHour, tz);

  if (currentHourUTC !== utcHour) return;

  // Check day of week in user's timezone
  const localDay = getLocalDay(tz); // 0=Sun ... 6=Sat
  const allowedDays = cfg.days || [0, 1, 2, 3, 4];
  if (!allowedDays.includes(localDay)) return;

  const today = todayStr();

  // Prevent duplicate sends — check if we already generated today
  const { data: existing } = await supabase
    .from('briefing_items')
    .select('id')
    .eq('user_id', profile.id)
    .eq('briefing_date', today)
    .limit(1);

  if (existing?.length) return; // already generated today

  await generateBriefing(profile, today, cfg);
}

async function generateBriefing(profile, today, cfg) {
  const userId = profile.id;

  // ── 1. Load accounts ─────────────────────────────────────────────────────
  const { data: accounts } = await supabase
    .from('accounts')
    .select(`
      id, name, health_score, churn_risk, nps, ces, product_usage,
      open_tickets, renewal_date, last_contact, stage,
      activity_log ( type, logged_at ),
      milestones   ( id, text, done )
    `)
    .eq('user_id', userId)
    .eq('archived', false);

  // ── 2. Load tasks ─────────────────────────────────────────────────────────
  const { data: tasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('done', false);

  // ── 3. Load recent survey responses (last 24h) ─────────────────────────
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { data: surveyResponses } = await supabase
    .from('survey_responses')
    .select('survey_id, score, submitted_at, surveys(type, account_id, accounts(name))')
    .gte('submitted_at', yesterday.toISOString())
    .eq('surveys.user_id', userId);

  const shapedResponses = (surveyResponses || []).map(r => ({
    type:         r.surveys?.type,
    score:        r.score,
    account_id:   r.surveys?.account_id,
    account_name: r.surveys?.accounts?.name,
  })).filter(r => r.type && r.account_id);

  // ── 4. Load pending items from previous days (carry-forward) ──────────
  const { data: pendingItems } = await supabase
    .from('briefing_items')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lt('briefing_date', today);

  const snoozedItems = await supabase
    .from('briefing_items')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'snoozed')
    .lte('snoozed_until', today);

  const carryPool = [
    ...(pendingItems || []),
    ...(snoozedItems.data || []),
  ];

  // ── 5. Scan fresh signals ────────────────────────────────────────────────
  const freshAccountSignals = scanAccountSignals(accounts || []);
  const freshTaskSignals    = scanTaskSignals(tasks || []);
  const freshWins           = scanWins(accounts || [], shapedResponses);

  // ── 6. Merge carry-forward with fresh signals ─────────────────────────
  const itemsToInsert = [];
  const carryMap = new Map(carryPool.map(i => [i.signal_type + ':' + (i.account_id || i.signal_detail), i]));

  for (const sig of [...freshAccountSignals, ...freshTaskSignals]) {
    const key = sig.signalType + ':' + (sig.accountId || sig.signalDetail);
    const carried = carryMap.get(key);
    const carryDays = carried ? (carried.carry_days + 1) : 0;
    const score = currentScore(sig.baseScore, carryDays);

    if (score >= THRESHOLD || sig.category === 'task') {
      itemsToInsert.push({
        user_id:       userId,
        account_id:    sig.accountId || null,
        briefing_date: today,
        category:      sig.category || 'action',
        signal_type:   sig.signalType,
        signal_detail: sig.signalDetail,
        base_score:    sig.baseScore,
        carry_days:    carryDays,
        current_score: score,
        status:        'pending',
      });
    }
    carryMap.delete(key); // handled
  }

  // Wins — always insert fresh, no carry
  for (const win of freshWins) {
    itemsToInsert.push({
      user_id:       userId,
      account_id:    win.accountId || null,
      briefing_date: today,
      category:      'win',
      signal_type:   win.signalType,
      signal_detail: win.signalDetail,
      base_score:    0,
      carry_days:    0,
      current_score: 0,
      status:        'pending',
    });
  }

  if (itemsToInsert.length === 0) return;

  const { data: insertedItems } = await supabase
    .from('briefing_items')
    .insert(itemsToInsert)
    .select();

  // ── 7. Optionally send email ──────────────────────────────────────────────
  if (cfg.email_enabled) {
    await maybeSendEmail(profile, today, insertedItems || []);
  }

  console.log(`[Briefing] Generated ${itemsToInsert.length} items for ${profile.email}`);
}

async function maybeSendEmail(profile, date, items) {
  // Find primary connected email account
  const { data: emailAccount } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('user_id', profile.id)
    .eq('is_primary', true)
    .maybeSingle();

  if (!emailAccount) {
    console.log(`[Briefing] No Gmail connected for ${profile.email}, skipping email send`);
    return;
  }

  const account = await refreshGmailToken(emailAccount);

  const actionItems  = items.filter(i => i.category === 'action').sort((a,b) => b.current_score - a.current_score);
  const overdueItems = items.filter(i => i.category === 'task' && i.signal_type === 'task_overdue');
  const dueTodayItems = items.filter(i => i.category === 'task' && i.signal_type === 'task_due_today');
  const wins         = items.filter(i => i.category === 'win');

  const html = buildBriefingEmail({
    csm: { full_name: profile.full_name, email: profile.email },
    date,
    actionItems,
    overdueItems,
    dueTodayItems,
    wins,
    appUrl: APP_URL,
  });

  const subject = `Your Pulse Briefing — ${new Date(date).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}`;

  await sendViaGmail(account, account.email, subject, html);
  console.log(`[Briefing] Email sent to ${account.email}`);
}

// ── Gmail send (reuses same pattern as emailAuth.js) ──────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function refreshGmailToken(account) {
  // Decrypt stored tokens into plaintext for API use
  const plainAccess  = decrypt(account.access_token);
  const plainRefresh = decrypt(account.refresh_token);

  const now     = Date.now();
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : null;

  if (expires && expires - now > 5 * 60_000) {
    return { ...account, access_token: plainAccess, refresh_token: plainRefresh };
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: plainRefresh });
  const { credentials } = await oauth2Client.refreshAccessToken();

  await supabase.from('email_accounts').update({
    access_token:     encrypt(credentials.access_token),
    token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
  }).eq('id', account.id);

  return { ...account, access_token: credentials.access_token, refresh_token: plainRefresh };
}

async function sendViaGmail(account, to, subject, htmlBody) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token:  account.access_token,
    refresh_token: account.refresh_token,
  });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const raw = makeRaw(account.email, account.display_name, to, subject, htmlBody);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

function makeRaw(fromEmail, fromName, to, subject, html) {
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
function localHourToUTC(localHour, timezone) {
  try {
    const now = new Date();
    const localStr = now.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
    const localNow = parseInt(localStr, 10);
    const utcNow = now.getUTCHours();
    const offset = ((utcNow - localNow) + 24) % 24;
    return (localHour + offset) % 24;
  } catch {
    // Fallback: treat as UTC
    return localHour;
  }
}

function getLocalDay(timezone) {
  try {
    const dayStr = new Date().toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short' });
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(dayStr);
  } catch {
    return new Date().getDay();
  }
}

module.exports = { runBriefingEngine, generateBriefing };
