// services/context-engine/retrieval.js — 6-stage context retrieval pipeline
//
// getContext(query, opts) → { interactions: [...], traceIds: [...] }
//
// Stages (each is a separate exported function for unit testing):
//   1. expandQuery      — LLM generates 2 alternative phrasings
//   2. keywordSearch    — Postgres full-text search (ts_rank)
//   3. vectorSearch     — cosine similarity on interaction_embeddings
//   4. entityFilter     — boost/filter by accountId if provided
//   5. mergeAndRank     — deduplicate, score by recency + source weight + similarity
//   6. windowAndCite    — load top N full records; attach citation IDs
//
// INVARIANT: every SQL query that touches interactions data includes
//   AND i.org_id = $orgId   (or equivalent)
// This is non-negotiable — org_id isolation is tested explicitly.

const supabase = require('../../supabase');
const llm      = require('../llm');

// Source freshness weights (call transcripts are highest signal)
const SOURCE_WEIGHTS = {
  call_transcript: 1.00,
  email_thread:    0.90,
  internal_note:   0.80,
  health_signal:   0.70,
  crm_event:       0.60,
  whatsapp:        0.50,
};

// Recency decay: half-life of 30 days
function recencyScore(occurredAt) {
  const ageMs      = Date.now() - new Date(occurredAt).getTime();
  const ageDays    = ageMs / 86_400_000;
  return Math.exp(-ageDays * Math.LN2 / 30);
}

// ── Stage 1: expandQuery ──────────────────────────────────────────────────────

async function expandQuery({ orgId, query, createdBy }) {
  const { output } = await llm.classify({
    orgId,
    feature: 'context_retrieval',
    system:  'You generate search query variations. Output ONLY a JSON array of 2 alternative phrasings. No explanation.',
    user:    `Original query: "${query}"\n\nReturn a JSON array of 2 alternative phrasings that would retrieve the same information. Example: ["alt 1", "alt 2"]`,
    maxTokens: 128,
    createdBy,
  });

  try {
    const alternatives = JSON.parse(output.trim());
    if (Array.isArray(alternatives)) return [query, ...alternatives.slice(0, 2)];
  } catch {
    // Malformed JSON — fall back to single query
  }
  return [query];
}

// ── Stage 2: keywordSearch ────────────────────────────────────────────────────

async function keywordSearch({ orgId, queries }) {
  const results = [];

  for (const q of queries) {
    // Sanitise query for plainto_tsquery (removes special chars)
    const sanitised = q.replace(/[^a-zA-Z0-9؀-ۿ\s]/g, ' ').trim();
    if (!sanitised) continue;

    const { data, error } = await supabase.rpc('search_interactions_text', {
      p_org_id: orgId,
      p_query:  sanitised,
      p_limit:  20,
    });

    // If the RPC doesn't exist yet, fall back to ILIKE
    if (error) {
      const { data: fallback } = await supabase
        .from('interactions')
        .select('id, org_id, account_id, source, direction, content, occurred_at, metadata')
        .eq('org_id', orgId)                 // org_id isolation
        .ilike('content', `%${sanitised}%`)
        .order('occurred_at', { ascending: false })
        .limit(20);

      for (const row of fallback || []) {
        results.push({ ...row, ft_rank: 0.5, _stage: 'keyword' });
      }
    } else {
      for (const row of data || []) {
        results.push({ ...row, _stage: 'keyword' });
      }
    }
  }

  return results;
}

// ── Stage 3: vectorSearch ─────────────────────────────────────────────────────

async function vectorSearch({ orgId, query, createdBy }) {
  // Generate query embedding — logged to ai_traces
  const { embedding } = await llm.embed({
    orgId,
    feature:   'context_retrieval',
    text:      query,
    createdBy,
  });

  // Cosine similarity search with strict org_id filter via JOIN
  const { data, error } = await supabase.rpc('search_interactions_vector', {
    p_org_id:        orgId,
    p_embedding:     embedding,
    p_match_count:   20,
  });

  if (error) {
    console.warn('[retrieval] vector search RPC not available:', error.message);
    return [];
  }

  return (data || []).map(row => ({ ...row, _stage: 'vector' }));
}

// ── Stage 4: entityFilter ─────────────────────────────────────────────────────

async function entityFilter({ orgId, accountId, interactionIds }) {
  if (!accountId || interactionIds.length === 0) return new Set();

  // Verify these interaction IDs belong to the account AND this org
  const { data } = await supabase
    .from('interactions')
    .select('id')
    .eq('org_id', orgId)          // org_id isolation
    .eq('account_id', accountId)
    .in('id', interactionIds);

  return new Set((data || []).map(r => r.id));
}

// ── Stage 5: mergeAndRank ─────────────────────────────────────────────────────

function mergeAndRank({ keywordResults, vectorResults, accountMatchIds, accountId }) {
  // Merge all candidates, keyed by interaction ID
  const byId = new Map();

  const addResult = (row, ftRank, vectorSim) => {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id:          row.id,
        org_id:      row.org_id,
        account_id:  row.account_id,
        source:      row.source,
        direction:   row.direction,
        content:     row.content,
        occurred_at: row.occurred_at,
        metadata:    row.metadata,
        ft_rank:     0,
        vector_sim:  0,
      });
    }
    const entry = byId.get(row.id);
    entry.ft_rank    = Math.max(entry.ft_rank,    ftRank    || 0);
    entry.vector_sim = Math.max(entry.vector_sim, vectorSim || 0);
  };

  for (const r of keywordResults) addResult(r, r.ft_rank || 0.5, 0);
  for (const r of vectorResults)  addResult(r, 0, r.similarity || 0);

  // Score each candidate
  const scored = [...byId.values()].map(r => {
    const recency      = recencyScore(r.occurred_at);
    const sourceWeight = SOURCE_WEIGHTS[r.source] || 0.5;
    const accountBoost = accountId && accountMatchIds?.has(r.id) ? 1.5 : 1.0;
    const relevance    = 0.4 * r.ft_rank + 0.6 * r.vector_sim;

    return {
      ...r,
      _score: recency * sourceWeight * relevance * accountBoost,
    };
  });

  return scored.sort((a, b) => b._score - a._score);
}

// ── Stage 6: windowAndCite ────────────────────────────────────────────────────

async function windowAndCite({ orgId, ranked, limit = 10 }) {
  const top  = ranked.slice(0, limit);
  const ids  = top.map(r => r.id);

  if (ids.length === 0) return [];

  // Load full content for selected IDs — org_id check is defence-in-depth
  const { data, error } = await supabase
    .from('interactions')
    .select('id, org_id, account_id, source, direction, content, summary, sentiment, language, occurred_at, external_id, metadata, created_at')
    .eq('org_id', orgId)          // org_id isolation — mandatory even with service role
    .in('id', ids);

  if (error) throw new Error(`windowAndCite fetch failed: ${error.message}`);

  // Preserve ranking order
  const byId = new Map((data || []).map(r => [r.id, r]));
  return top
    .map((r, idx) => ({ ...byId.get(r.id), _rank: idx + 1, _score: r._score }))
    .filter(Boolean);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * getContext — retrieve the most relevant interactions for a query.
 *
 * @param {string} query
 * @param {object} opts
 * @param {string}  opts.orgId        — REQUIRED for isolation
 * @param {string}  [opts.accountId]  — boost interactions from this account
 * @param {number}  [opts.limit=10]   — max interactions to return
 * @param {string}  [opts.createdBy]  — user ID for ai_traces
 * @returns {Promise<{interactions: object[], traceIds: string[]}>}
 */
async function getContext(query, { orgId, accountId, limit = 10, createdBy } = {}) {
  if (!orgId) throw new Error('getContext: orgId is required');

  // Stage 1: expand query
  const queries = await expandQuery({ orgId, query, createdBy });

  // Stages 2 & 3 run in parallel
  const [keywordResults, vectorResults] = await Promise.all([
    keywordSearch({ orgId, queries }),
    vectorSearch({ orgId, query, createdBy }),
  ]);

  // Stage 4: entity filter (which of the candidates belong to accountId)
  const candidateIds   = [...new Set([
    ...keywordResults.map(r => r.id),
    ...vectorResults.map(r => r.id),
  ])];
  const accountMatchIds = await entityFilter({ orgId, accountId, interactionIds: candidateIds });

  // Stage 5: merge + rank
  const ranked = mergeAndRank({ keywordResults, vectorResults, accountMatchIds, accountId });

  // Stage 6: load full records + citations
  const interactions = await windowAndCite({ orgId, ranked, limit });

  return {
    interactions,
    citationIds: interactions.map(i => i.id),
  };
}

module.exports = {
  getContext,
  // exported for unit testing:
  expandQuery,
  keywordSearch,
  vectorSearch,
  entityFilter,
  mergeAndRank,
  windowAndCite,
};
