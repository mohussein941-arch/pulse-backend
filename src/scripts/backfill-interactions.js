// scripts/backfill-interactions.js — one-time backfill from legacy tables → interactions
//
// Run against STAGING ONLY until M1 backend code ships to production.
// Usage:
//   NODE_ENV=staging node src/scripts/backfill-interactions.js
//   Add --dry-run to see counts without writing
//
// Idempotent: uses external_id to skip already-backfilled rows.
// Reports row counts before and after each source.
//
// Sources:
//   meeting_notes  → source: call_transcript   (external_id: fireflies_id)
//   email_threads  → source: email_thread      (external_id: gmail_thread_id)
//   activity_log   → source: internal_note     (external_id: hash of org_id+account_id+type+logged_at)
//   ces_history    → source: health_signal     (external_id: hash of account_id+recorded_at+type)
//   health_history → source: health_signal     (external_id: hash of account_id+recorded_at)

require('dotenv').config();

const crypto   = require('crypto');
const supabase = require('../supabase');

const DRY_RUN  = process.argv.includes('--dry-run');
const BATCH    = 100;

function makeHash(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

async function countTable(table) {
  const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
  return count || 0;
}

async function countInteractionsBySource(source) {
  const { count } = await supabase
    .from('interactions')
    .select('*', { count: 'exact', head: true })
    .eq('source', source);
  return count || 0;
}

async function externalIdExists(externalId) {
  const { data } = await supabase
    .from('interactions')
    .select('id')
    .eq('external_id', externalId)
    .maybeSingle();
  return !!data;
}

async function insertInteraction(row) {
  if (DRY_RUN) return true;
  const { error } = await supabase.from('interactions').insert(row);
  if (error && error.code !== '23505') {  // 23505 = unique_violation (race condition safe)
    console.error('  insert error:', error.message, JSON.stringify(row).slice(0, 200));
    return false;
  }
  return true;
}

// ── meeting_notes → call_transcript ──────────────────────────────────────────

async function backfillMeetingNotes() {
  console.log('\n── meeting_notes → interactions (source: call_transcript) ──');
  const before = await countInteractionsBySource('call_transcript');
  console.log(`  interactions.call_transcript before: ${before}`);

  let offset = 0, written = 0, skipped = 0;

  while (true) {
    const { data, error } = await supabase
      .from('meeting_notes')
      .select('id, org_id, account_id, user_id, fireflies_id, title, summary, meeting_date, participants, action_items, organizer_email, synced_at')
      .order('synced_at')
      .range(offset, offset + BATCH - 1);

    if (error) { console.error('  fetch error:', error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const externalId = row.fireflies_id || makeHash('meeting_note', row.id);

      if (await externalIdExists(externalId)) { skipped++; continue; }

      const content = [row.title && `Title: ${row.title}`, row.summary]
        .filter(Boolean).join('\n\n');

      const ok = await insertInteraction({
        org_id:      row.org_id,
        account_id:  row.account_id || null,
        source:      'call_transcript',
        direction:   'internal',
        content:     content || null,
        summary:     row.summary || null,
        language:    'en',
        occurred_at: row.meeting_date || row.synced_at,
        created_by:  row.user_id || null,
        external_id: externalId,
        metadata: {
          title:           row.title,
          participants:    row.participants,
          action_items:    row.action_items,
          organizer_email: row.organizer_email,
          source_table:    'meeting_notes',
          source_id:       row.id,
        },
      });
      if (ok) written++;
    }

    offset += data.length;
    if (data.length < BATCH) break;
  }

  const after = await countInteractionsBySource('call_transcript');
  console.log(`  written: ${written}, skipped (already exist): ${skipped}`);
  console.log(`  interactions.call_transcript after: ${after}`);
}

// ── email_threads → email_thread ──────────────────────────────────────────────

async function backfillEmailThreads() {
  console.log('\n── email_threads → interactions (source: email_thread) ──');
  const before = await countInteractionsBySource('email_thread');
  console.log(`  interactions.email_thread before: ${before}`);

  let offset = 0, written = 0, skipped = 0;

  while (true) {
    const { data, error } = await supabase
      .from('email_threads')
      .select('id, org_id, account_id, user_id, gmail_thread_id, subject, snippet, last_message_at, message_count, is_unread_reply, synced_at')
      .order('synced_at')
      .range(offset, offset + BATCH - 1);

    if (error) { console.error('  fetch error:', error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const externalId = row.gmail_thread_id || makeHash('email_thread', row.id);

      if (await externalIdExists(externalId)) { skipped++; continue; }

      const ok = await insertInteraction({
        org_id:      row.org_id,
        account_id:  row.account_id || null,
        source:      'email_thread',
        direction:   'inbound',
        content:     row.snippet || null,
        language:    'en',
        occurred_at: row.last_message_at || row.synced_at,
        created_by:  row.user_id || null,
        external_id: externalId,
        metadata: {
          subject:         row.subject,
          message_count:   row.message_count,
          is_unread_reply: row.is_unread_reply,
          source_table:    'email_threads',
          source_id:       row.id,
        },
      });
      if (ok) written++;
    }

    offset += data.length;
    if (data.length < BATCH) break;
  }

  const after = await countInteractionsBySource('email_thread');
  console.log(`  written: ${written}, skipped (already exist): ${skipped}`);
  console.log(`  interactions.email_thread after: ${after}`);
}

// ── activity_log → internal_note ─────────────────────────────────────────────

async function backfillActivityLog() {
  console.log('\n── activity_log → interactions (source: internal_note) ──');
  const before = await countInteractionsBySource('internal_note');
  console.log(`  interactions.internal_note before: ${before}`);

  let offset = 0, written = 0, skipped = 0;

  while (true) {
    const { data, error } = await supabase
      .from('activity_log')
      .select('id, org_id, account_id, user_id, type, note, logged_at, created_at')
      .order('created_at')
      .range(offset, offset + BATCH - 1);

    if (error) { console.error('  fetch error:', error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const externalId = makeHash('activity_log', row.org_id || '', row.account_id || '', row.type || '', row.logged_at || row.created_at || '');

      if (await externalIdExists(externalId)) { skipped++; continue; }

      const ok = await insertInteraction({
        org_id:      row.org_id,
        account_id:  row.account_id || null,
        source:      'internal_note',
        direction:   'internal',
        content:     [row.type, row.note].filter(Boolean).join(': ') || null,
        language:    'en',
        occurred_at: row.logged_at || row.created_at,
        created_by:  row.user_id || null,
        external_id: externalId,
        metadata: {
          type:         row.type,
          source_table: 'activity_log',
          source_id:    row.id,
        },
      });
      if (ok) written++;
    }

    offset += data.length;
    if (data.length < BATCH) break;
  }

  const after = await countInteractionsBySource('internal_note');
  console.log(`  written: ${written}, skipped (already exist): ${skipped}`);
  console.log(`  interactions.internal_note after: ${after}`);
}

// ── ces_history → health_signal ───────────────────────────────────────────────

async function backfillCesHistory() {
  console.log('\n── ces_history → interactions (source: health_signal) ──');

  let offset = 0, written = 0, skipped = 0;

  while (true) {
    const { data, error } = await supabase
      .from('ces_history')
      .select('id, org_id, account_id, value, recorded_at')
      .order('recorded_at')
      .range(offset, offset + BATCH - 1);

    if (error) { console.error('  fetch error:', error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const externalId = makeHash('ces_history', row.account_id || '', row.recorded_at || '');

      if (await externalIdExists(externalId)) { skipped++; continue; }

      const ok = await insertInteraction({
        org_id:      row.org_id,
        account_id:  row.account_id || null,
        source:      'health_signal',
        direction:   'inbound',
        content:     `CES score: ${row.value}`,
        language:    'en',
        occurred_at: row.recorded_at,
        external_id: externalId,
        metadata: {
          signal_type:  'ces',
          value:        row.value,
          source_table: 'ces_history',
          source_id:    row.id,
        },
      });
      if (ok) written++;
    }

    offset += data.length;
    if (data.length < BATCH) break;
  }

  const after = await countInteractionsBySource('health_signal');
  console.log(`  written: ${written}, skipped (already exist): ${skipped}`);
  console.log(`  interactions.health_signal after: ${after}`);
}

// ── health_history → health_signal ───────────────────────────────────────────

async function backfillHealthHistory() {
  console.log('\n── health_history → interactions (source: health_signal) ──');

  let offset = 0, written = 0, skipped = 0;

  while (true) {
    const { data, error } = await supabase
      .from('health_history')
      .select('id, org_id, account_id, score, recorded_at')
      .order('recorded_at')
      .range(offset, offset + BATCH - 1);

    if (error) { console.error('  fetch error:', error.message); break; }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const externalId = makeHash('health_history', row.account_id || '', row.recorded_at || '');

      if (await externalIdExists(externalId)) { skipped++; continue; }

      const ok = await insertInteraction({
        org_id:      row.org_id,
        account_id:  row.account_id || null,
        source:      'health_signal',
        direction:   'inbound',
        content:     `Health score: ${row.score}`,
        language:    'en',
        occurred_at: row.recorded_at,
        external_id: externalId,
        metadata: {
          signal_type:  'health_snapshot',
          score:        row.score,
          source_table: 'health_history',
          source_id:    row.id,
        },
      });
      if (ok) written++;
    }

    offset += data.length;
    if (data.length < BATCH) break;
  }

  const after = await countInteractionsBySource('health_signal');
  console.log(`  written: ${written}, skipped (already exist): ${skipped}`);
  console.log(`  interactions.health_signal after: ${after}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  Pulse M1 — interactions backfill                      ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);
  console.log(`  Target: ${process.env.SUPABASE_URL}`);

  const totalBefore = await countTable('interactions');
  console.log(`\n  interactions total before backfill: ${totalBefore}`);

  await backfillMeetingNotes();
  await backfillEmailThreads();
  await backfillActivityLog();
  await backfillCesHistory();
  await backfillHealthHistory();

  const totalAfter = await countTable('interactions');
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  Backfill complete                                      ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
  console.log(`  interactions total before: ${totalBefore}`);
  console.log(`  interactions total after:  ${totalAfter}`);
  console.log(`  net new rows: ${totalAfter - totalBefore}`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
