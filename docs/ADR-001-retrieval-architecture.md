# ADR-001 — Retrieval Architecture for the Pulse Context Engine

**Status:** Accepted  
**Date:** 2026-05-24  
**Milestone:** M1  
**Authors:** Mohamed Hussein (product), Claude Code (implementation)

---

## Context

Pulse needs to surface relevant customer history to CSMs — during pre-meeting prep, at deal close, and inline while writing a note. The input is a natural language query from a CSM or an automated pipeline. The output is a ranked list of interactions (call transcripts, emails, notes, health signals) from the customer's timeline.

The core design question: how do we retrieve the right interactions, and how do we rank them?

---

## Decision

**Hybrid retrieval: keyword search + vector similarity, merged by a composite ranking function.**

The pipeline has six stages, each independently testable:

1. **expandQuery** — Haiku generates two alternative phrasings of the user's query. This costs ~$0.00045 per call and meaningfully improves recall on abbreviated or jargon-heavy CSM queries.
2. **keywordSearch** — Postgres full-text search (`plainto_tsquery` via RPC, ILIKE fallback). Fast. Covers exact terms, product names, and numeric values that semantic search misses.
3. **vectorSearch** — Cosine similarity on `interaction_embeddings` (1536-dim, `text-embedding-3-small`). Parallel with keyword search.
4. **entityFilter** — If an `accountId` is provided, computes which candidate IDs belong to that account.
5. **mergeAndRank** — Deduplicates candidates from stages 2+3; scores each by `recency × sourceWeight × (0.4 × ft_rank + 0.6 × vector_sim) × accountBoost`.
6. **windowAndCite** — Loads the top N full records; re-asserts `org_id` as defence-in-depth.

---

## Options considered

### Option A: Vector search only
Embed every query; retrieve by cosine similarity alone.

**Rejected because:** Exact-match queries (product version numbers, named features, specific dates) underperform against short interaction snippets. Health signals and CES scores — which are short numeric strings — embed poorly. We'd lose the ability to search by exact account name or ticket ID.

### Option B: Keyword search only (Postgres FTS)
Use `plainto_tsquery` / `ts_rank` across content.

**Rejected because:** CSMs ask questions like "is the customer happy about the recent changes?" — paraphrase retrieval requires semantic matching. Keyword-only misses synonyms, tone, and concept-level queries. Also degrades as multi-language support grows.

### Option C: Hybrid retrieval (chosen)
Run both in parallel; merge with a composite score weighted 40% keyword / 60% vector.

**Accepted.** The 40/60 split reflects the expectation that semantic queries dominate real use cases, while keeping keyword recall strong for named entities and exact matches. The weighting is a tunable parameter in `mergeAndRank` — no schema change required to adjust it.

### Option D: BM25 + vector (two-tower with separate BM25 index)
Dedicated BM25 index (e.g. via `pg_bm25` / ParadeDB) alongside pgvector.

**Deferred.** At current scale (< 50k interactions per org), Postgres FTS is adequate. BM25 indexing adds operational overhead and a new extension dependency. Track in TECH_DEBT.md for M6+ when volume justifies it.

---

## Ranking formula rationale

```
score = recency × sourceWeight × (0.4 × ft_rank + 0.6 × vector_sim) × accountBoost
```

**Recency decay** (`exp(−ageDays × ln2 / 30)`, half-life 30 days): Customer relationships change. A call from two months ago is less relevant than one from last week, all else being equal. Half-life of 30 days was chosen to keep content relevant for a full billing cycle without aggressively discarding older context.

**Source weights** (call_transcript 1.0 → whatsapp 0.5): Reflects signal quality and CSM workflow priority. Call transcripts contain the richest structured context; WhatsApp messages are often brief logistics. Weights are tunable without schema changes.

**Account boost** (1.5× for same-account interactions): If the CSM specifies an `accountId`, their interactions should rank first. The 1.5× multiplier is conservative — it boosts without completely excluding cross-account results, which can sometimes be valuable (e.g., querying for industry-wide renewal patterns).

**Relevance split** (40% keyword / 60% vector): Reflects the expectation that most CSM queries are conceptual ("how is this customer feeling about the product?") rather than exact-match. Reversing the split would be the first tuning action if exact-term queries become the dominant pattern.

---

## Isolation invariant

Every SQL stage that touches `interactions` data includes `AND org_id = $orgId` (or an equivalent join constraint). This is:

- Documented as a code invariant in `retrieval.js:14`
- Tested by `scripts/test-isolation.js` (4 assertions: keyword isolation, vector isolation, cross-ID fetch)
- Re-asserted in `windowAndCite` even though candidates are already filtered — defence-in-depth against future refactors

Violating this invariant causes multi-tenant data leakage. It is not optional.

---

## Embedding strategy

**Single vector per interaction via mean-pooling of 500-token chunks.**

Content longer than 500 tokens (~375 words) is split into chunks, each embedded independently, then averaged into a single 1536-dim vector. This keeps the schema simple (`UNIQUE(interaction_id, model)` — one row per interaction) and avoids the complexity of chunk-level retrieval for M1.

**Known limitation:** Mean-pooling loses fine-grained positional information for long documents. A 2000-word transcript's embedding represents the whole document, not its most relevant passage. Chunk-level rows would allow retrieving the specific passage that matches a query. This is tracked in TECH_DEBT.md and is the natural M6 upgrade path.

**Why `text-embedding-3-small`:** 1536 dimensions, $0.020/MTok — the best cost/quality ratio available at time of decision. `text-embedding-3-large` (3072 dims, $0.130/MTok) offers marginally better quality at 6.5× the cost. Not justified for M1.

---

## Cost profile per `getContext()` call

| Stage | Model | Estimated cost |
|---|---|---|
| expandQuery | Haiku 4.5 | ~$0.00045 |
| vectorSearch (embed query) | text-embedding-3-small | ~$0.0000002 |
| All SQL stages | — | $0 |
| **Total** | | **~$0.00045** |

Against the `context_retrieval` budget of $0.01: **22× headroom**.

The `reason()` call (Sonnet 4.6) is billed separately under the consuming feature's budget (e.g., `pre_meeting_brief` at $0.03).

---

## Consequences

**Positive:**
- Simple to operate — no external retrieval service, just Postgres + pgvector
- All stages independently testable and tunable
- Cost is predictable and low (~$0.00045/query for context retrieval itself)
- Isolation is provably correct (SQL invariant + test)

**Negative / accepted:**
- Vector search requires embeddings to exist — new interactions aren't searchable until the worker runs (up to 30s lag)
- Mean-pooling limits fine-grained passage retrieval for long transcripts
- ILIKE fallback (when FTS RPC is missing) doesn't use the GIN index — acceptable at current scale, not at 100k+ interactions

**Future tuning triggers:**
- CSM feedback (`ai_traces.feedback`) shows low recall on exact-term queries → increase keyword weight
- P99 latency > 500ms on vector search → add `lists` parameter to ivfflat index, or upgrade index type
- Average org has > 50k interactions → evaluate BM25 / ParadeDB
