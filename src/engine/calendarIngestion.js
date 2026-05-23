// engine/calendarIngestion.js
// Syncs Google Calendar events for all connected accounts.
// Detects customer meetings by matching event attendees against org stakeholders.
// Writes matched events to interactions (source: calendar_event).
//
// Window: -30 days to +14 days (captures recent history + upcoming meetings).
// occurred_at = event start time (not sync time) per M2a spec.
// Cancelled events are skipped at ingest; reconciliation is deferred (TECH_DEBT.md).

const { google }   = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { getEncoding } = require('js-tiktoken');
const { decrypt, encrypt } = require('../utils/crypto');
const { writeInteraction } = require('../services/context-engine/ingestion');
const { getCalendarOAuthClient } = require('../routes/calendarAuth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYNC_DAYS_PAST   = 30;
const SYNC_DAYS_FUTURE = 14;
const MAX_BODY_TOKENS  = 8_000;

let enc = null;
function getEnc() {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc;
}

function truncateToTokens(text, maxTokens) {
  const tokenIds = getEnc().encode(text);
  if (tokenIds.length <= maxTokens) return text;
  const decoder = new TextDecoder();
  return decoder.decode(getEnc().decode(tokenIds.slice(0, maxTokens)));
}

// ── Main entry — called by cron ───────────────────────────────────────────────
async function runCalendarSync() {
  console.log('[Calendar Sync] Starting...');

  const { data: calendarAccounts } = await supabase
    .from('email_accounts')
    .select('user_id')
    .eq('provider', 'google_calendar');

  if (!calendarAccounts?.length) {
    console.log('[Calendar Sync] No Google Calendar accounts connected.');
    return;
  }

  const userIds = [...new Set(calendarAccounts.map(a => a.user_id))];

  for (const userId of userIds) {
    try {
      const result = await syncCalendarForUser(userId);
      console.log(`[Calendar Sync] User ${userId}: ${result.matched} events matched`);
    } catch (err) {
      console.error(`[Calendar Sync] Failed for user ${userId}:`, err.message);
    }
  }

  console.log('[Calendar Sync] Complete.');
}

// ── Sync all calendar accounts for one user ───────────────────────────────────
async function syncCalendarForUser(userId) {
  const { data: calendarAccounts } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google_calendar');

  if (!calendarAccounts?.length) return { synced: 0, matched: 0 };

  // Bridge userId → orgId for org-scoped interaction writes
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .maybeSingle();
  const orgId = membership?.org_id;

  if (!orgId) {
    console.warn(`[Calendar Sync] User ${userId} has no org membership — skipping`);
    return { synced: 0, matched: 0 };
  }

  // Build stakeholder email → accountId and domain → accountId maps
  const { emailMap, domainMap } = await buildOrgMatchMaps(orgId);

  let totalSynced = 0;
  let totalMatched = 0;

  for (const calAccount of calendarAccounts) {
    try {
      const result = await syncOneCalendarAccount(calAccount, userId, orgId, emailMap, domainMap);
      totalSynced  += result.synced;
      totalMatched += result.matched;
    } catch (err) {
      console.error(`[Calendar Sync] Error for ${calAccount.email}:`, err.message);
    }
  }

  return { synced: totalSynced, matched: totalMatched };
}

// ── Sync one connected calendar account ──────────────────────────────────────
async function syncOneCalendarAccount(calAccount, userId, orgId, emailMap, domainMap) {
  const calendar = await getAuthedCalendarClient(calAccount);

  const now        = new Date();
  const timeMin    = new Date(now.getTime() - SYNC_DAYS_PAST  * 24 * 60 * 60 * 1000).toISOString();
  const timeMax    = new Date(now.getTime() + SYNC_DAYS_FUTURE * 24 * 60 * 60 * 1000).toISOString();

  let synced  = 0;
  let matched = 0;
  let pageToken;

  do {
    const params = {
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      showDeleted: false,
    };
    if (pageToken) params.pageToken = pageToken;

    const { data } = await calendar.events.list(params);
    const events   = data.items || [];
    pageToken      = data.nextPageToken;

    for (const event of events) {
      // Skip cancelled events — reconciliation is deferred (see TECH_DEBT.md)
      if (event.status === 'cancelled') continue;

      // Skip all-day events (no meaningful datetime for occurred_at)
      const startTime = event.start?.dateTime;
      if (!startTime) continue;

      const attendeeEmails = (event.attendees || [])
        .filter(a => !a.self && a.email)
        .map(a => a.email.toLowerCase());

      const accountId = matchToAccount(attendeeEmails, calAccount.email, emailMap, domainMap);

      synced++;
      if (!accountId) continue;
      matched++;

      const content = buildEventContent(event, event.id);

      await writeInteraction({
        orgId,
        accountId,
        source:     'calendar_event',
        direction:  'internal',
        content,
        externalId: `gcal:${event.id}`,
        timestamp:  startTime,
        createdBy:  userId,
        metadata: {
          title:       event.summary || '(no title)',
          start_time:  startTime,
          end_time:    event.end?.dateTime || null,
          attendees:   (event.attendees || []).map(a => a.email),
          location:    event.location || null,
          meet_link:   extractMeetLink(event),
          calendar_id: calAccount.email,
          event_id:    event.id,
        },
      });
    }
  } while (pageToken);

  return { synced, matched };
}

// ── Build plain-text content for the event ───────────────────────────────────
// Format: title / attendees / start time / blank line / description body (if present).
// Organizer included when different from the calendar owner — useful for retrieval
// ("who set up this meeting"). Location included when present.
// Token cap: 8k. Description is the only variable-length field in practice.
function buildEventContent(event, eventId) {
  const lines = [];

  // Line 1 — title
  lines.push(event.summary || '(no title)');

  // Line 2 — attendees (display name preferred over email where available)
  const attendees = (event.attendees || []).map(a =>
    a.displayName ? `${a.displayName} <${a.email}>` : a.email
  );
  if (attendees.length) lines.push(`Attendees: ${attendees.join(', ')}`);

  // Line 3 — start time
  if (event.start?.dateTime) {
    lines.push(`Start: ${new Date(event.start.dateTime).toUTCString()}`);
  }

  // Organizer (omit if it's a self-organised event — organizer.self === true)
  if (event.organizer && !event.organizer.self) {
    const org = event.organizer.displayName
      ? `${event.organizer.displayName} <${event.organizer.email}>`
      : event.organizer.email;
    lines.push(`Organizer: ${org}`);
  }

  if (event.location) lines.push(`Location: ${event.location}`);

  // Description — strip HTML, then apply token cap
  if (event.description) {
    const desc = event.description
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (desc) lines.push(`\n${desc}`);
  }

  let content = lines.join('\n');

  const tokens = getEnc().encode(content).length;
  if (tokens > MAX_BODY_TOKENS) {
    content = truncateToTokens(content, MAX_BODY_TOKENS);
    console.log(`[Calendar Ingestion] truncated event ${eventId}: ${tokens} → ${MAX_BODY_TOKENS} tokens`);
  }

  return content;
}

// ── Match attendee emails to a Pulse account ──────────────────────────────────
function matchToAccount(attendeeEmails, ownEmail, emailMap, domainMap) {
  for (const email of attendeeEmails) {
    const lc = email.toLowerCase();
    if (lc === ownEmail.toLowerCase()) continue;

    if (emailMap.has(lc)) return emailMap.get(lc);

    const domain = lc.split('@')[1];
    if (domain && domainMap.has(domain)) return domainMap.get(domain);
  }
  return null;
}

// ── Build org-scoped stakeholder + domain lookup maps ────────────────────────
async function buildOrgMatchMaps(orgId) {
  const emailMap  = new Map();
  const domainMap = new Map();

  const { data: stakeholders } = await supabase
    .from('stakeholders')
    .select('email, account_id')
    .eq('org_id', orgId)
    .not('email', 'is', null);

  for (const s of stakeholders || []) {
    if (s.email) emailMap.set(s.email.toLowerCase().trim(), s.account_id);
  }

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, domain')
    .eq('org_id', orgId)
    .eq('archived', false)
    .not('domain', 'is', null);

  for (const a of accounts || []) {
    if (a.domain) domainMap.set(a.domain.toLowerCase().trim(), a.id);
  }

  return { emailMap, domainMap };
}

// ── Get authenticated Google Calendar client, refreshing token if needed ─────
async function getAuthedCalendarClient(calAccount) {
  const plainAccess  = decrypt(calAccount.access_token);
  const plainRefresh = decrypt(calAccount.refresh_token);

  const now     = Date.now();
  const expires = calAccount.token_expires_at
    ? new Date(calAccount.token_expires_at).getTime() : null;

  let accessToken = plainAccess;

  if (!expires || expires - now < 5 * 60_000) {
    const oauth2Client = getCalendarOAuthClient();
    oauth2Client.setCredentials({ refresh_token: plainRefresh });
    const { credentials } = await oauth2Client.refreshAccessToken();

    await supabase.from('email_accounts').update({
      access_token:     encrypt(credentials.access_token),
      token_expires_at: credentials.expiry_date
        ? new Date(credentials.expiry_date).toISOString() : null,
    }).eq('id', calAccount.id);

    accessToken = credentials.access_token;
  }

  const oauth2Client = getCalendarOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: plainRefresh });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ── Extract Google Meet / video conference link from event ────────────────────
function extractMeetLink(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const ep = event.conferenceData?.entryPoints || [];
  const video = ep.find(e => e.entryPointType === 'video');
  return video?.uri || null;
}

module.exports = { runCalendarSync, syncCalendarForUser };
