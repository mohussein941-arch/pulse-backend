# Pulse Context Engine — Architecture

**Milestone:** M1  
**Status:** Shipped to staging branch `m1-context-engine`  
**Last updated:** 2026-05-24

---

## Overview

The Context Engine is the AI substrate beneath every Pulse feature that requires understanding of customer history. It gives any route a single call — `getContext(query, opts)` — that returns the most relevant interactions from a customer's timeline, ready to pass to an LLM for synthesis.

It is not a feature. It is infrastructure. The same substrate powers pre-meeting briefs (M2), post-meeting closeout (M3), and health narratives (M4).

---

## Directory layout

```
src/
  services/
    llm/
      index.js              LLM provider abstraction (classify / reason / embed)
    context-engine/
      ingestion.js          writeInteraction() — single write path for all signal sources
      embedding.js          Async worker: chunks content, embeds, upserts to interaction_embeddings
      retrieval.js          getContext() — 6-stage pipeline
      reasoning.js          reason() — synthesises retrieved context via LLM
      feedback.js           POST /api/ai/feedback — CSM accept/edit/reject on AI outputs
  scripts/
    backfill-interactions.js  One-time migration: legacy tables → interactions
    test-isolation.js         Multi-tenancy isolation test (4 SQL assertions)
    test-llm.js               Smoke test: classify() → ai_traces row with correct cost
```

---

## Database schema (M1 tables)

| Table | Purpose |
|---|---|
| `interactions` | Unified timeline: every customer signal from every source |
| `interaction_embeddings` | One 1536-dim vector per interaction (mean-pooled if chunked) |
| `entity_links` | Reserved: maps interactions to contacts, deals, tickets |
| `ai_traces` | Every LLM call: model, tokens, cost, latency, feedback |

All four tables carry `org_id` as a first-class column with a non-nullable FK to `organisations`. Every query in the engine includes `AND org_id = $orgId`. This is tested explicitly by `test-isolation.js`.

---

## Signal sources

| `source` value | Origin | `direction` |
|---|---|---|
| `call_transcript` | Fireflies ingestion engine | `internal` |
| `email_thread` | Gmail ingestion engine | `inbound` / `outbound` |
| `internal_note` | Activity log / manual CSM notes | `internal` |
| `health_signal` | CES history, health score snapshots | `inbound` |
| `crm_event` | CRM sync (HubSpot, Salesforce, etc.) | `internal` |
| `whatsapp` | WhatsApp webhook | `inbound` / `outbound` |

New sources are added by passing a new `source` value to `writeInteraction()`. The VALID_SOURCES array in `ingestion.js` is the gating list.

---

## LLM provider abstraction (`services/llm/index.js`)

Three methods. Every call writes one row to `ai_traces`.

| Method | Model | Use case | Default max tokens |
|---|---|---|---|
| `classify()` | `claude-haiku-4-5-20251001` | Classification, query expansion, entity tagging | 256 |
| `reason()` | `claude-sonnet-4-6` | Synthesis, narrative generation, briefs | 1024 |
| `embed()` | `text-embedding-3-small` | Vector embedding (1536d) | — |

All keys are server-side (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` env vars). There is no per-user BYOK in the context engine. The BYOK pattern for the legacy AI route lives in `src/utils/ai.js` and is separate.

### Pricing (verified 2026-05-23)

| Model | Input | Output |
|---|---|---|
| `claude-haiku-4-5-20251001` | $1.00/MTok | $5.00/MTok |
| `claude-sonnet-4-6` | $3.00/MTok | $15.00/MTok |
| `text-embedding-3-small` | $0.020/MTok | — |

### Feature cost budgets

Defined in `FEATURE_BUDGETS` in `services/llm/index.js`. These are reference values for cost discipline tests — not runtime enforcement.

| Feature | Budget |
|---|---|
| `context_retrieval` | $0.01 |
| `generate_embedding` | $0.001 |
| `briefing_summary` | $0.02 |
| `pre_meeting_brief` | $0.03 |
| `post_meeting_closeout` | $0.05 |
| `health_narrative` | $0.02 |

---

## Write path: `writeInteraction()`

```
Ingestion engine (Fireflies / Gmail / webhook)
  └─▶ writeInteraction({ orgId, accountId, source, direction, content, metadata, ... })
        ├─ validates source + direction
        ├─ inserts row to interactions
        └─ setImmediate → scheduleEmbedding(interactionId)   [non-blocking]
```

The caller gets the interaction UUID immediately. Embedding happens asynchronously in the background worker.

---

## Embedding worker (`embedding.js`)

```
startEmbeddingWorker()                  called at server startup
  ├─ pollUnembedded() immediately        catches any pre-existing unembedded rows
  └─ setInterval(pollUnembedded, 30s)   fallback poll every 30 seconds

scheduleEmbedding(id)                   called by writeInteraction()
  └─ pendingQueue.add(id)
     setImmediate(drainQueue)

drainQueue()
  └─ for each id: embedInteraction(id)
       ├─ fetch interaction content
       ├─ if already embedded → skip (UNIQUE guard)
       ├─ tokenise with cl100k_base (js-tiktoken)
       ├─ if tokens > 500 → chunk into 500-token slices
       ├─ embed each chunk via llm.embed()
       ├─ mean-pool chunk embeddings → single 1536-dim vector
       └─ upsert to interaction_embeddings (UNIQUE on interaction_id, model)
```

**Retry policy:** exponential backoff — 1s, 2s, 4s — up to 3 retries, then permanent failure log.

**Chunking note:** mean-pooling is accurate enough for retrieval at this scale. Per-chunk rows (better for long-document search) are tracked in TECH_DEBT.md as a future improvement.

---

## Retrieval pipeline: `getContext()`

```
getContext(query, { orgId, accountId, limit, createdBy })
  │
  ├─ Stage 1: expandQuery          classify() → 2 alternative phrasings
  │                                 Falls back to original query on JSON parse error
  │
  ├─ Stage 2: keywordSearch   ─┐
  │   (Postgres ILIKE / FTS)   │  run in parallel via Promise.all
  ├─ Stage 3: vectorSearch    ─┘
  │   (cosine similarity RPC, llm.embed() for query)
  │
  ├─ Stage 4: entityFilter         if accountId → Set of matching interaction IDs
  │
  ├─ Stage 5: mergeAndRank         composite score (see below)
  │
  └─ Stage 6: windowAndCite        load full records, re-assert org_id, attach _rank
```

### Composite score formula

```
score = recency × sourceWeight × (0.4 × ft_rank + 0.6 × vector_sim) × accountBoost
```

| Factor | Details |
|---|---|
| `recency` | `exp(−ageDays × ln2 / 30)` — half-life 30 days |
| `sourceWeight` | call_transcript 1.0, email_thread 0.9, internal_note 0.8, health_signal 0.7, crm_event 0.6, whatsapp 0.5 |
| `ft_rank` | Postgres `ts_rank` score (or 0.5 for ILIKE fallback) |
| `vector_sim` | cosine similarity from `search_interactions_vector` RPC |
| `accountBoost` | 1.5× if interaction belongs to the requested accountId, else 1.0 |

---

## Reasoning layer: `reason()`

```
reason(context, task, { orgId, feature, ... })
  ├─ formats interactions as numbered citation blocks [1], [2], ...
  ├─ caps each block at 800 chars
  └─ calls llm.reason() with citation map appended to prompt
     returns { output, citationIds, traceId }
```

Downstream routes (briefing, closeout, etc.) use this to generate human-readable text. The `citationIds` array is the source of truth for which interactions the model referenced — routes store it for auditability.

---

## Feedback loop: `POST /api/ai/feedback`

CSMs can accept, edit, or reject any AI output. This hits `ai_traces` directly:

```
POST /api/ai/feedback
  { trace_id, feedback: 'accept'|'edit'|'reject', notes? }
  └─ verifies trace.org_id === req.orgId (before update)
     updates ai_traces.feedback, feedback_notes, feedback_at
     returns 204
```

Feedback data is not acted on in M1. It is collected now for M7+ model quality work.

---

## Multi-tenancy isolation

Every SQL query in the retrieval pipeline includes `AND org_id = $orgId` or equivalent. This is not a best-effort convention — it is a documented invariant and is tested by `scripts/test-isolation.js`:

1. keywordSearch(OrgA) returns zero OrgB rows
2. keywordSearch(OrgB) returns zero OrgA rows  
3. windowAndCite(orgId=OrgA, ids=OrgB) returns 0 rows
4. Direct `interactions.select` with `eq('org_id', OrgA)` contains only OrgA rows

All 4 tests pass on staging. See M1_VALIDATION.md for full results.

---

## Cost discipline

- Every LLM call writes to `ai_traces` — no call is untracked
- `FEATURE_BUDGETS` documents the per-call ceiling for each feature
- `ai_traces` can be queried at any time for cost roll-ups by feature, org, or time window
- The 30 AI calls/hour rate limit on `/api/ai/*` (set in `server.js`) is the first line of defence against runaway cost

---

## Adding a new ingestion source

1. Add the new `source` string to `VALID_SOURCES` in `ingestion.js`
2. Call `writeInteraction({ orgId, source: 'new_source', ... })` from the new ingestion engine
3. Add a `sourceWeight` entry to `SOURCE_WEIGHTS` in `retrieval.js`
4. If the source has unique metadata fields, document them in the `metadata` JSONB shape

No schema changes required — `metadata` is JSONB and absorbs any source-specific fields.
