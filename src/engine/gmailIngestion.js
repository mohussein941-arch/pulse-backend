// engine/gmailIngestion.js
// Syncs Gmail threads for all connected accounts, matches them to Pulse accounts
// via stakeholder emails (primary) and account domain (fallback).
//
// M2a changes:
//   - Fetches full message body (format:'full') for Context Engine indexing
//   - Strips quoted reply text and HTML before writing to interactions
//   - Truncates at 8k tokens; logs every truncation and HTML-strip for quality auditing
//   - Bridges userId → orgId via org_members so interactions are org-scoped
//   - Calls writeInteraction() alongside existing email_threads upsert

const { google }         = require('googleapis');
const { createClient }   = require('@supabase/supabase-js');
const { getEncoding }    = require('js-tiktoken');
const { decrypt, encrypt } = require('../utils/crypto');
const { writeInteraction } = require('../services/context-engine/ingestion');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DAYS_BACK        = 90;    // how far back to look for threads
const MAX_THREADS      = 250;   // max threads per Gmail account per sync
const MAX_BODY_TOKENS  = 8_000; // truncation ceiling before embedding

let enc = null;
function getEnc() {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc;
}

function countTokens(text) {
  return getEnc().encode(text).length;
}

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

  // 2. Bridge userId → orgId for interactions table
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .maybeSingle();
  const orgId = membership?.org_id || null;

  // 3. Build matching maps: email → accountId, domain → accountId
  //    Use org-scoped queries when orgId is available, fall back to user-scoped
  const { emailMap, domainMap } = await buildMatchMaps(userId, orgId);

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
        emailAccount, userId, orgId, emailMap, domainMap
      );
      totalSynced  += result.synced;
      totalMatched += result.matched;
      result.accountIds.forEach(id => matchedAccountIds.add(id));
    } catch (err) {
      console.error(`[Gmail Sync] Error for ${emailAccount.email}:`, err.message);
    }
  }

  // 4. Update last_contact on all matched accounts
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
async function buildMatchMaps(userId, orgId) {
  const emailMap  = new Map();
  const domainMap = new Map();

  // Prefer org-scoped lookups when org is available (matches M0b schema)
  const stakeholderQuery = supabase
    .from('stakeholders')
    .select('account_id, email')
    .not('email', 'is', null);
  if (orgId) {
    stakeholderQuery.eq('org_id', orgId);
  } else {
    stakeholderQuery.eq('user_id', userId);
  }
  const { data: stakeholders } = await stakeholderQuery;

  for (const s of stakeholders || []) {
    if (s.email) emailMap.set(s.email.toLowerCase().trim(), s.account_id);
  }

  const accountQuery = supabase
    .from('accounts')
    .select('id, domain')
    .eq('archived', false)
    .not('domain', 'is', null);
  if (orgId) {
    accountQuery.eq('org_id', orgId);
  } else {
    accountQuery.eq('user_id', userId);
  }
  const { data: accounts } = await accountQuery;

  for (const a of accounts || []) {
    if (a.domain) domainMap.set(a.domain.toLowerCase().trim(), a.id);
  }

  return { emailMap, domainMap };
}

// ── Sync one connected Gmail account ─────────────────────────────────────────
async function syncOneGmailAccount(emailAccount, userId, orgId, emailMap, domainMap) {
  const gmail = await getAuthedGmailClient(emailAccount);

  const afterTs = Math.floor(
    (Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000
  );

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
      // Fetch full message payload (not metadata-only) to get body content
      const { data: thread } = await gmail.users.threads.get({
        userId:  'me',
        id:      threadItem.id,
        format:  'full',
      });

      const parsed    = parseThread(thread, emailAccount.email);
      const accountId = matchToAccount(parsed.participants, emailAccount.email, emailMap, domainMap);

      // ── Legacy email_threads upsert (preserved for UI consumers) ─────────
      await supabase.from('email_threads').upsert({
        user_id:          userId,
        account_id:       accountId || null,
        gmail_thread_id:  thread.id,
        subject:          parsed.subject,
        participants:     parsed.participants,
        last_message_at:  parsed.lastMessageAt,
        last_message_from: parsed.lastMessageFrom,
        snippet:          parsed.snippet,
        message_count:    thread.messages.length,
        is_unread_reply:  parsed.isUnreadReply,
        synced_at:        new Date().toISOString(),
      }, { onConflict: 'user_id,gmail_thread_id', ignoreDuplicates: false });

      // ── interactions write (M2a) ──────────────────────────────────────────
      if (accountId && orgId) {
        const externalId = `gmail:${thread.id}`;
        const content    = buildThreadContent(parsed, thread.id);

        await writeInteraction({
          orgId,
          accountId,
          source:     'email_thread',
          direction:  parsed.direction,
          content,
          externalId,
          timestamp:  parsed.lastMessageAt,
          createdBy:  userId,
          metadata: {
            subject:        parsed.subject,
            participants:   parsed.participants,
            message_count:  thread.messages.length,
            gmail_thread_id: thread.id,
          },
        });
      }

      // ── Activity log (deduped via external_ref) ───────────────────────────
      if (accountId) {
        await supabase.from('activity_log').upsert({
          user_id:      userId,
          account_id:   accountId,
          type:         'Email',
          source:       'gmail_auto',
          external_ref: `gmail:${thread.id}`,
          note:         parsed.subject !== '(no subject)'
            ? `Email thread: ${parsed.subject}`
            : `Email thread with ${parsed.participants.slice(0, 2).join(', ')}`,
          logged_at:    parsed.lastMessageAt.split('T')[0],
        }, { onConflict: 'user_id,external_ref', ignoreDuplicates: true });
      }

      synced.push(thread.id);
      if (accountId) accountIds.add(accountId);
    } catch {
      // Skip individual thread failures silently
    }
  }

  return { synced: synced.length, matched: accountIds.size, accountIds };
}

// ── Build clean text content from thread for Context Engine ──────────────────
function buildThreadContent(parsed, threadId) {
  let text = parsed.bodyText;

  // Strip quoted reply text using standard patterns
  text = stripQuotedText(text);

  // Truncate at 8k tokens, log every truncation for retrieval quality auditing
  const tokens = countTokens(text);
  if (tokens > MAX_BODY_TOKENS) {
    text = truncateToTokens(text, MAX_BODY_TOKENS);
    console.log(`[Gmail Ingestion] truncated thread ${threadId}: ${tokens} → ${MAX_BODY_TOKENS} tokens`);
  }

  return text.trim() || null;
}

// ── Extract body text from Gmail full-format thread ───────────────────────────
// Tries text/plain first; falls back to HTML-stripped text/html.
// Logs every HTML strip for retrieval quality auditing.
function extractBodyFromThread(thread, ownEmail, threadId) {
  const messages = thread.messages || [];
  // Use the last message in the thread (most recent content)
  const lastMsg  = messages[messages.length - 1];
  if (!lastMsg?.payload) return '';

  const plain = extractPartByMime(lastMsg.payload, 'text/plain');
  if (plain) return decodeBase64Url(plain);

  const html = extractPartByMime(lastMsg.payload, 'text/html');
  if (html) {
    const stripped = stripHtml(decodeBase64Url(html));
    console.log(`[Gmail Ingestion] HTML-stripped thread ${threadId} (no text/plain part)`);
    return stripped;
  }

  return '';
}

// Recursively find the first MIME part matching the given mimeType
function extractPartByMime(payload, mimeType) {
  if (payload.mimeType === mimeType) {
    return payload.body?.data || null;
  }
  for (const part of payload.parts || []) {
    const found = extractPartByMime(part, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBase64Url(b64) {
  // Gmail uses base64url encoding
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

// ── HTML → plain text ─────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    // Remove entire <style> and <script> blocks
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Replace block elements with newlines
    .replace(/<(br|p|div|tr|li|h[1-6])[^>]*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse runs of whitespace to single spaces / newlines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Strip quoted reply text ───────────────────────────────────────────────────
function stripQuotedText(text) {
  // "On [date], [name] wrote:" — Gmail / Apple Mail standard
  text = text.replace(/\nOn .{10,80},?\s*[\r\n]?.{5,100} wrote:\s*[\r\n][\s\S]*/i, '');

  // "From: ... Sent: ... To: ... Subject: ..." — Outlook style
  text = text.replace(/\n[-\s]*Original Message[-\s]*\n[\s\S]*/i, '');
  text = text.replace(/\nFrom:.*\nSent:.*\nTo:.*\nSubject:[\s\S]*/i, '');

  // Lines beginning with > (standard email quote prefix)
  text = text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n');

  // Clean up trailing whitespace after removal
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Truncate text to N tokens ─────────────────────────────────────────────────
function truncateToTokens(text, maxTokens) {
  const tokenIds = getEnc().encode(text);
  if (tokenIds.length <= maxTokens) return text;
  const decoder    = new TextDecoder();
  const truncated  = tokenIds.slice(0, maxTokens);
  return decoder.decode(getEnc().decode(truncated));
}

// ── Parse thread metadata + body into usable structure ───────────────────────
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

  const dateHeader    = getHeader('Date');
  const lastMessageAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  // True when last message is from a participant (not CSM) — CSM hasn't replied
  const isUnreadReply = lastMessageFrom.toLowerCase() !== ownEmail.toLowerCase();

  // Direction from CSM's perspective
  const direction = isUnreadReply ? 'inbound' : 'outbound';

  // Extract body text from the full payload
  const bodyText = extractBodyFromThread(thread, ownEmail, thread.id);

  return {
    subject,
    participants,
    lastMessageAt,
    lastMessageFrom,
    snippet,
    isUnreadReply,
    direction,
    bodyText,
  };
}

// ── Match participant emails to an account ────────────────────────────────────
function matchToAccount(participants, ownEmail, emailMap, domainMap) {
  for (const email of participants) {
    const lc = email.toLowerCase();
    if (lc === ownEmail.toLowerCase()) continue;

    if (emailMap.has(lc)) return emailMap.get(lc);

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
