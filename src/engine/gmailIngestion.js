// engine/gmailIngestion.js
// Syncs Gmail threads for all connected accounts, matches them to Pulse accounts
// via stakeholder emails (primary) and account domain (fallback).

const { google }         = require('googleapis');
const { createClient }   = require('@supabase/supabase-js');
const { decrypt, encrypt } = require('../utils/crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DAYS_BACK   = 90;   // how far back to look for threads
const MAX_THREADS = 250;  // max threads per Gmail account per sync

// ── OAuth client ──────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ── Main entry — called by cron and on-demand sync endpoint ──────────────────
async function syncGmailForUser(userId) {
  // 1. Get connected Gmail accounts
  const { data: emailAccounts } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'gmail');

  if (!emailAccounts?.length) return { synced: 0, matched: 0, accounts: 0 };

  // 2. Build matching maps: email → accountId, domain → accountId
  const { emailMap, domainMap } = await buildMatchMaps(userId);

  if (emailMap.size === 0 && domainMap.size === 0) {
    return { synced: 0, matched: 0, accounts: 0,
      hint: 'Add stakeholder emails or account domains to enable thread matching.' };
  }

  let totalSynced  = 0;
  let totalMatched = 0;
  const matchedAccountIds = new Set();

  for (const emailAccount of emailAccounts) {
    try {
      const result = await syncOneGmailAccount(
        emailAccount, userId, emailMap, domainMap
      );
      totalSynced  += result.synced;
      totalMatched += result.matched;
      result.accountIds.forEach(id => matchedAccountIds.add(id));
    } catch (err) {
      console.error(`[Gmail Sync] Error for ${emailAccount.email}:`, err.message);
    }
  }

  // 3. Update last_contact on all matched accounts
  await updateLastContacts(userId, matchedAccountIds);

  return { synced: totalSynced, matched: totalMatched, accounts: matchedAccountIds.size };
}

// ── Run for all users — called by hourly cron ─────────────────────────────────
async function runGmailSync() {
  console.log('[Gmail Sync] Starting...');

  const { data: emailAccounts } = await supabase
    .from('email_accounts')
    .select('user_id')
    .eq('provider', 'gmail');

  if (!emailAccounts?.length) { console.log('[Gmail Sync] No Gmail accounts connected.'); return; }

  const userIds = [...new Set(emailAccounts.map(a => a.user_id))];

  for (const userId of userIds) {
    try {
      const result = await syncGmailForUser(userId);
      console.log(`[Gmail Sync] User ${userId}: ${result.matched} threads matched across ${result.accounts} accounts`);
    } catch (err) {
      console.error(`[Gmail Sync] Failed for user ${userId}:`, err.message);
    }
  }

  console.log('[Gmail Sync] Complete.');
}

// ── Build email→accountId and domain→accountId lookup maps ───────────────────
async function buildMatchMaps(userId) {
  const emailMap  = new Map(); // 'john@acme.com' → accountId
  const domainMap = new Map(); // 'acme.com'      → accountId

  // Stakeholder emails (most reliable)
  const { data: stakeholders } = await supabase
    .from('stakeholders')
    .select('account_id, email')
    .eq('user_id', userId)
    .not('email', 'is', null);

  for (const s of stakeholders || []) {
    if (s.email) emailMap.set(s.email.toLowerCase().trim(), s.account_id);
  }

  // Account domains (fallback)
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, domain')
    .eq('user_id', userId)
    .eq('archived', false)
    .not('domain', 'is', null);

  for (const a of accounts || []) {
    if (a.domain) domainMap.set(a.domain.toLowerCase().trim(), a.id);
  }

  return { emailMap, domainMap };
}

// ── Sync one connected Gmail account ─────────────────────────────────────────
async function syncOneGmailAccount(emailAccount, userId, emailMap, domainMap) {
  const gmail = await getAuthedGmailClient(emailAccount);

  const afterTs = Math.floor(
    (Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000
  );

  // Fetch thread list (metadata only — fast, no content download)
  const { data: listData } = await gmail.users.threads.list({
    userId:     'me',
    q:          `after:${afterTs} -in:spam -in:trash -in:promotions -category:promotions`,
    maxResults: MAX_THREADS,
  });

  const threadItems = listData.threads || [];
  const synced      = [];
  const accountIds  = new Set();

  for (const threadItem of threadItems) {
    try {
      const { data: thread } = await gmail.users.threads.get({
        userId:          'me',
        id:              threadItem.id,
        format:          'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
      });

      const parsed    = parseThread(thread, emailAccount.email);
      const accountId = matchToAccount(parsed.participants, emailAccount.email, emailMap, domainMap);

      if (!accountId) continue;

      await supabase.from('email_threads').upsert({
        user_id:          userId,
        account_id:       accountId,
        gmail_thread_id:  thread.id,
        subject:          parsed.subject,
        participants:     parsed.participants,
        last_message_at:  parsed.lastMessageAt,
        last_message_from: parsed.lastMessageFrom,
        snippet:          parsed.snippet,
        message_count:    thread.messages.length,
        is_unread_reply:  parsed.isUnreadReply(emailAccount.email),
        synced_at:        new Date().toISOString(),
      }, { onConflict: 'user_id,gmail_thread_id', ignoreDuplicates: false });

      synced.push(thread.id);
      accountIds.add(accountId);
    } catch {
      // Skip individual thread failures silently
    }
  }

  return { synced: synced.length, matched: synced.length, accountIds };
}

// ── Parse thread metadata into usable structure ───────────────────────────────
function parseThread(thread, ownEmail) {
  const messages    = thread.messages || [];
  const lastMessage = messages[messages.length - 1];
  const headers     = lastMessage?.payload?.headers || [];

  const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const subject         = getHeader('Subject') || '(no subject)';
  const lastMessageFrom = extractEmail(getHeader('From'));
  const snippet         = thread.snippet ? thread.snippet.slice(0, 300) : null;

  // Collect all unique participant emails across all messages
  const allEmails = new Set();
  for (const msg of messages) {
    const hdrs = msg.payload?.headers || [];
    const h    = name => hdrs.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    extractAllEmails(h('From') + ' ' + h('To') + ' ' + h('Cc')).forEach(e => allEmails.add(e));
  }
  const participants = [...allEmails].filter(e => e !== ownEmail.toLowerCase());

  // Determine last message date
  const dateHeader = getHeader('Date');
  const lastMessageAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  return {
    subject,
    participants,
    lastMessageAt,
    lastMessageFrom,
    snippet,
    isUnreadReply: (ownEmail) => {
      // True when last message is from a participant (not CSM) — CSM hasn't replied
      return lastMessageFrom.toLowerCase() !== ownEmail.toLowerCase();
    },
  };
}

// ── Match participant emails to an account ────────────────────────────────────
function matchToAccount(participants, ownEmail, emailMap, domainMap) {
  for (const email of participants) {
    const lc = email.toLowerCase();
    if (lc === ownEmail.toLowerCase()) continue; // skip own email

    // 1. Direct stakeholder email match
    if (emailMap.has(lc)) return emailMap.get(lc);

    // 2. Domain match
    const domain = lc.split('@')[1];
    if (domain && domainMap.has(domain)) return domainMap.get(domain);
  }
  return null;
}

// ── Update last_contact on matched accounts using latest thread date ──────────
async function updateLastContacts(userId, accountIds) {
  for (const accountId of accountIds) {
    const { data } = await supabase
      .from('email_threads')
      .select('last_message_at')
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.last_message_at) continue;

    const emailDate = data.last_message_at.split('T')[0];

    // Only update if this email date is more recent than the stored last_contact
    await supabase
      .from('accounts')
      .update({ last_contact: emailDate, updated_at: new Date().toISOString() })
      .eq('id', accountId)
      .eq('user_id', userId)
      .or(`last_contact.is.null,last_contact.lt.${emailDate}`);
  }
}

// ── Get authenticated Gmail client, refreshing token if needed ────────────────
async function getAuthedGmailClient(emailAccount) {
  const plainAccess  = decrypt(emailAccount.access_token);
  const plainRefresh = decrypt(emailAccount.refresh_token);

  const now     = Date.now();
  const expires = emailAccount.token_expires_at
    ? new Date(emailAccount.token_expires_at).getTime() : null;

  let accessToken = plainAccess;

  if (!expires || expires - now < 5 * 60_000) {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ refresh_token: plainRefresh });
    const { credentials } = await oauth2Client.refreshAccessToken();

    await supabase.from('email_accounts').update({
      access_token:     encrypt(credentials.access_token),
      token_expires_at: credentials.expiry_date
        ? new Date(credentials.expiry_date).toISOString() : null,
    }).eq('id', emailAccount.id);

    accessToken = credentials.access_token;
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: plainRefresh });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── Email parsing helpers ─────────────────────────────────────────────────────
function extractEmail(header) {
  const match = header.match(/<([^>]+)>/) || header.match(/([^\s]+@[^\s]+)/);
  return match ? match[1].toLowerCase().trim() : header.toLowerCase().trim();
}

function extractAllEmails(headerStr) {
  const matches = headerStr.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.map(e => e.toLowerCase().trim());
}

module.exports = { syncGmailForUser, runGmailSync };
