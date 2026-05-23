# Technical Debt

## M1 Context Engine — deferred items

### Embedding: chunk-level rows vs mean-pooling

Currently `interaction_embeddings` stores one mean-pooled vector per interaction. For long transcripts (2000+ words), this loses fine-grained passage retrieval — you can find the document but not the specific paragraph that best matches a query.

**Upgrade path:** Store one row per chunk (`UNIQUE(interaction_id, chunk_index, model)`) and retrieve the top-K chunks, then deduplicate to interaction level. This requires a schema change and a worker rewrite.

**Triggers:** Consider when average org has > 10k interactions OR CSM feedback shows poor recall on specific-fact queries from long transcripts.

### pollUnembedded: NOT IN subquery at scale

`embedding.js` polls for unembedded interactions with:
```sql
WHERE id NOT IN (SELECT interaction_id FROM interaction_embeddings WHERE model = '...')
```

This will degrade past ~100k rows per org. Replace with a LEFT JOIN or a `NOT EXISTS` correlated subquery with a composite index on `(interaction_id, model)` in `interaction_embeddings`.

**Triggers:** Embedding poll latency > 1s, or org has > 50k interactions.

### Retrieval: keyword search uses ILIKE fallback

`search_interactions_text` RPC (FTS with `plainto_tsquery`) is the intended path. The ILIKE fallback in `keywordSearch()` does not use the GIN index and scans all org rows.

**Fix:** Deploy the `search_interactions_text` RPC via a migration once M1 ships to production. The RPC code exists in `supabase/migration_m1.sql`.

### Retrieval: BM25 scoring instead of ts_rank

Postgres `ts_rank` is term-frequency based but not BM25-normalised. At scale, BM25 (via `pg_bm25` / ParadeDB) would improve precision on short queries against long documents.

**Triggers:** Average org > 50k interactions and CSM feedback shows exact-term query drift.

---

## Deferred M0b workload tables

These four tables were audited in M0b and confirmed to be user_id-scoped only (no org_id column).
They must be migrated before any cross-org feature references them.
The migration pattern to follow is identical to `supabase/migration_m0b_meeting_notes.sql`:
additive (add nullable org_id FK, backfill from org_members, set NOT NULL, update RLS policy, add org index).
Create `supabase/migration_m0b_workload_tables.sql` when ready.

| Table             | What it is                                   | Blocks milestone          |
|-------------------|----------------------------------------------|---------------------------|
| briefing_items    | Daily briefing engine output rows per CSM    | M5 — org-level priority queue |
| outreach_queue    | AI-drafted outreach items per account        | M3 — close-out write-back |
| survey_schedules  | Per-user survey send schedule config         | M5 — org-level survey config |
| digest_schedules  | Per-user health digest schedule config       | M5 — org-level digest config |
