// services/context-engine/embedding.js — async embedding worker
//
// Two entry points:
//   scheduleEmbedding(interactionId)  — queues a single interaction for immediate embedding
//   startEmbeddingWorker()            — starts the 30s fallback poll loop
//
// Chunking: content > 500 tokens is split into 500-token chunks.
// Since interaction_embeddings has UNIQUE(interaction_id, model), we average
// the chunk embeddings into a single vector. This is standard mean-pooling.
// Schema improvement (chunk-level rows) is tracked in TECH_DEBT.md.

const { getEncoding }  = require('js-tiktoken');
const supabase         = require('../../supabase');
const llm              = require('../llm');

const CHUNK_TOKENS     = 500;
const POLL_INTERVAL_MS = 30_000;
const MAX_RETRIES      = 3;
const EMBEDDING_MODEL  = 'text-embedding-3-small';

let enc = null;
function getEnc() {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc;
}

// In-memory queue of interaction IDs pending embedding (deduplicates rapid calls)
const pendingQueue = new Set();
let workerRunning  = false;

// ── Token counting + chunking ─────────────────────────────────────────────────

function countTokens(text) {
  return getEnc().encode(text).length;
}

function chunkText(text) {
  const tokens     = getEnc().encode(text);
  const decoder    = new TextDecoder();
  const chunks     = [];

  for (let i = 0; i < tokens.length; i += CHUNK_TOKENS) {
    const slice     = tokens.slice(i, i + CHUNK_TOKENS);
    // Re-decode token IDs to text for the API call
    const chunkText = decoder.decode(getEnc().decode(slice));
    chunks.push(chunkText);
  }
  return chunks.length > 0 ? chunks : [text];
}

function averageEmbeddings(embeddings) {
  if (embeddings.length === 1) return embeddings[0];
  const dim  = embeddings[0].length;
  const avg  = new Array(dim).fill(0);
  for (const vec of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += vec[i];
  }
  const scale = 1 / embeddings.length;
  return avg.map(v => v * scale);
}

// ── Core embedding logic ──────────────────────────────────────────────────────

async function embedInteraction(interactionId, retryCount = 0) {
  // Load the interaction (service role bypasses RLS)
  const { data: interaction, error: fetchErr } = await supabase
    .from('interactions')
    .select('id, org_id, account_id, content, created_by')
    .eq('id', interactionId)
    .maybeSingle();

  if (fetchErr) throw new Error(`fetch interaction failed: ${fetchErr.message}`);
  if (!interaction) {
    console.warn(`[embedding] interaction ${interactionId} not found — skipping`);
    return;
  }
  if (!interaction.content?.trim()) {
    console.warn(`[embedding] interaction ${interactionId} has no content — skipping`);
    return;
  }

  // Skip if already embedded with this model
  const { data: existing } = await supabase
    .from('interaction_embeddings')
    .select('id')
    .eq('interaction_id', interactionId)
    .eq('model', EMBEDDING_MODEL)
    .maybeSingle();

  if (existing) return; // already embedded

  const tokenCount = countTokens(interaction.content);
  const chunks     = tokenCount > CHUNK_TOKENS
    ? chunkText(interaction.content)
    : [interaction.content];

  if (chunks.length > 1) {
    console.log(`[embedding] ${interactionId}: ${tokenCount} tokens → ${chunks.length} chunks`);
  }

  try {
    const chunkEmbeddings = [];
    for (const chunk of chunks) {
      const { embedding } = await llm.embed({
        orgId:         interaction.org_id,
        feature:       'generate_embedding',
        text:          chunk,
        accountId:     interaction.account_id,
        interactionId: interaction.id,
        createdBy:     interaction.created_by,
      });
      chunkEmbeddings.push(embedding);
    }

    const finalEmbedding = averageEmbeddings(chunkEmbeddings);

    const { error: insertErr } = await supabase
      .from('interaction_embeddings')
      .upsert({
        interaction_id: interactionId,
        embedding:      finalEmbedding,
        model:          EMBEDDING_MODEL,
      }, { onConflict: 'interaction_id,model' });

    if (insertErr) throw new Error(`embedding insert failed: ${insertErr.message}`);

    console.log(`[embedding] ✓ ${interactionId} (${chunks.length} chunk${chunks.length > 1 ? 's' : ''}, ${tokenCount} tokens)`);
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = 1000 * Math.pow(2, retryCount);
      console.warn(`[embedding] retry ${retryCount + 1}/${MAX_RETRIES} for ${interactionId} in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
      return embedInteraction(interactionId, retryCount + 1);
    }
    throw err;
  }
}

// ── Queue management ──────────────────────────────────────────────────────────

async function scheduleEmbedding(interactionId) {
  pendingQueue.add(interactionId);
  if (!workerRunning) {
    setImmediate(drainQueue);
  }
}

async function drainQueue() {
  if (workerRunning || pendingQueue.size === 0) return;
  workerRunning = true;

  const ids = [...pendingQueue];
  pendingQueue.clear();

  for (const id of ids) {
    try {
      await embedInteraction(id);
    } catch (err) {
      console.error(`[embedding] permanent failure for ${id}: ${err.message}`);
    }
  }

  workerRunning = false;

  // Process any items that arrived while we were running
  if (pendingQueue.size > 0) setImmediate(drainQueue);
}

// ── Fallback poll loop ────────────────────────────────────────────────────────

async function pollUnembedded() {
  try {
    // Fetch already-embedded IDs first; Supabase JS doesn't support raw subqueries
    // in .not('id', 'in', ...) — it expects a value list, not SQL.
    const { data: embedded } = await supabase
      .from('interaction_embeddings')
      .select('interaction_id')
      .eq('model', EMBEDDING_MODEL);

    const embeddedIds = (embedded || []).map(r => r.interaction_id);

    let query = supabase
      .from('interactions')
      .select('id')
      .not('content', 'is', null)
      .limit(50);

    if (embeddedIds.length > 0) {
      query = query.not('id', 'in', `(${embeddedIds.join(',')})`);
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('[embedding] poll query failed:', error.message);
      return;
    }

    for (const row of rows || []) {
      pendingQueue.add(row.id);
    }

    if (pendingQueue.size > 0 && !workerRunning) {
      setImmediate(drainQueue);
    }
  } catch (err) {
    console.error('[embedding] poll error:', err.message);
  }
}

function startEmbeddingWorker() {
  // Run once immediately on startup to catch any interactions from before this deploy
  pollUnembedded();
  setInterval(pollUnembedded, POLL_INTERVAL_MS);
  console.log(`  Embedding worker started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
}

module.exports = { scheduleEmbedding, startEmbeddingWorker, embedInteraction };
