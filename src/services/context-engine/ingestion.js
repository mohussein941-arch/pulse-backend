// services/context-engine/ingestion.js — write interactions to the unified table
//
// writeInteraction() is the single entry point for all signal sources:
// Fireflies transcripts, Gmail threads, Calendar events, internal notes,
// CRM events, health signals, and WhatsApp messages.
//
// When externalId is provided, writeInteraction is idempotent: if a row with
// (org_id, external_id) already exists, the existing ID is returned without
// a second insert. The DB also enforces this via idx_interactions_org_external.

const supabase = require('../../supabase');
const { scheduleEmbedding } = require('./embedding');

const VALID_SOURCES    = ['call_transcript', 'email_thread', 'internal_note', 'crm_event', 'health_signal', 'whatsapp', 'calendar_event'];
const VALID_DIRECTIONS = ['inbound', 'outbound', 'internal'];

/**
 * Write a single interaction and trigger an async embedding job.
 *
 * @param {object} params
 * @param {string}  params.orgId       — required
 * @param {string}  [params.accountId] — FK to accounts
 * @param {string}  params.source      — one of VALID_SOURCES
 * @param {string}  [params.direction] — 'inbound' | 'outbound' | 'internal'
 * @param {string}  [params.content]   — raw text body
 * @param {object}  [params.metadata]  — source-specific fields (subject, duration, etc.)
 * @param {string}  [params.timestamp] — ISO 8601, defaults to now()
 * @param {string}  [params.contactId] — stored in metadata (no interactions column)
 * @param {string}  [params.createdBy] — FK to auth.users
 * @param {string}  [params.externalId]— source-system ID for idempotency
 * @returns {Promise<string>} new (or existing) interaction UUID
 */
async function writeInteraction({
  orgId,
  accountId,
  source,
  direction,
  content,
  metadata = {},
  timestamp,
  contactId,
  createdBy,
  externalId,
}) {
  if (!orgId)   throw new Error('writeInteraction: orgId is required');
  if (!source)  throw new Error('writeInteraction: source is required');

  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`writeInteraction: invalid source "${source}". Must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  if (direction && !VALID_DIRECTIONS.includes(direction)) {
    throw new Error(`writeInteraction: invalid direction "${direction}". Must be one of: ${VALID_DIRECTIONS.join(', ')}`);
  }

  // Idempotency guard — return early if this external record is already ingested
  if (externalId) {
    const { data: existing } = await supabase
      .from('interactions')
      .select('id')
      .eq('org_id', orgId)
      .eq('external_id', externalId)
      .maybeSingle();

    if (existing) return existing.id;
  }

  const meta = contactId ? { ...metadata, contact_id: contactId } : metadata;

  const { data, error } = await supabase
    .from('interactions')
    .insert({
      org_id:      orgId,
      account_id:  accountId  || null,
      source,
      direction:   direction  || null,
      content:     content    || null,
      metadata:    meta,
      occurred_at: timestamp  || new Date().toISOString(),
      created_by:  createdBy  || null,
      external_id: externalId || null,
    })
    .select('id')
    .single();

  if (error) throw new Error(`writeInteraction DB error: ${error.message}`);

  const interactionId = data.id;

  // Fire embedding asynchronously — do not await (caller gets the ID immediately)
  if (content?.trim()) {
    setImmediate(() => scheduleEmbedding(interactionId).catch(err =>
      console.error(`[ingestion] scheduleEmbedding failed for ${interactionId}:`, err.message)
    ));
  }

  return interactionId;
}

module.exports = { writeInteraction, VALID_SOURCES };
