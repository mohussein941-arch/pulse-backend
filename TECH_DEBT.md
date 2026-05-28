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

## Calendar event cancellation reconciliation

When a Google Calendar event is cancelled after it has already been ingested as an `interaction`, the existing interaction row is NOT updated. The sync engine skips cancelled events on initial ingest but has no reconciliation pass to mark or tombstone previously written interactions.

**Upgrade path:** On each calendar sync pass, fetch the last N days of cancelled events separately (using `showDeleted=true` and `eventTypes=cancelled` on the Google Calendar API), then update matching `interactions` rows (set a `cancelled` flag in `metadata` or soft-delete). Requires a `metadata.cancelled` convention and UI treatment in the brief generator to suppress cancelled meetings.

**Triggers:** First report of a cancelled-meeting brief misleading a CSM.

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

---

## M2d: Dual-source playbook content (added 2026-05-26)

The `playbooks` DB table is now the brief engine's source of truth (12 system rows with `org_id = NULL`). The frontend (`App.jsx` `PLAYBOOK_LIBRARY` constant) continues to read from its own hardcoded copy.

**Consequence:** Any change to playbook content must be applied in **both** places — DB seed (via a new migration patching the relevant rows) and `PLAYBOOK_LIBRARY` in `App.jsx` — or briefs and the UI will drift.

**Triggers:** Must be resolved before any per-org playbook customisation feature ships. The UI must read from `/api/playbooks` (a future endpoint) rather than the hardcoded constant, so that org-specific overrides are reflected in both the brief and the playbook browser.

**Note:** `commsTemplate` text was omitted from the `steps` jsonb in the seed migration (migration_m2d.sql) to keep the migration reviewable; `App.jsx` remains the authoritative source of comms copy until a backend endpoint serves it.

---

## Seed loader: tickets skipped (HubSpot Service Hub scopes unavailable)

`tools/seed-generator/load_to_hubspot.py` does not push tickets to HubSpot because the Beacon test workspace does not expose Service Hub ticket scopes (tickets pipeline/object access).

**Upgrade path:** When Pulse adds a non-HubSpot ticket source (Zendesk or Jira integration), feed `output/tickets.json` through that path instead. The `load_tickets()` function remains in the loader and can be re-enabled once the correct HubSpot scopes are provisioned.

**Triggers:** First integration of a ticketing system (Zendesk, Jira, or HubSpot Service Hub upgrade on the test workspace).

---

## Migration notes

- migration_m2b v4 review missed an undefined function reference (current_user_id was used in RLS policies but never defined in any migration). Fixed pre-apply by substituting auth.uid() in all six call sites. Lesson: v4-reviewed migrations are not infallible — verify referenced functions/objects exist in the target DB before applying.

---

## ErrorBoundary architecture (M2 frontend)

Top-level ErrorBoundary is in place in `App.jsx`. Per-component boundaries (Detail panel, Settings) are a future UX improvement: a broken account view would currently show the global fallback rather than a scoped one confined to that panel.

**Triggers:** Any point where a per-component failure silently degrading to the global boundary becomes unacceptable UX.

---

## 402 double-fire on /api/ai/briefing-summary

The 402 response fires twice on briefing load. Investigate quota / billing state on the Anthropic API key in the Railway environment.

**Triggers:** Before enabling the briefing engine in production for end users.

---

## csm_profile RLS scoping — RESOLVED/CORRECTED (2026-05-28)

~~The `csm_profile` table is keyed on `id = auth.uid()` (one row per user). Current DELETE and UPDATE RLS policies scope on `org_id = current_org_id()`.~~

**Ground truth (verified against production pg_policies 2026-05-28):**
- There is **no DELETE policy** on `csm_profile`. Table-owner / service-role deletes are unrestricted; anon/authenticated deletes are blocked by default-deny.
- The **SELECT and UPDATE** policies both scope on `((id = auth.uid()) AND (org_id = current_org_id()))` — both predicates are present; `org_id` is not the sole scope.
- The **INSERT** WITH CHECK is `((id = auth.uid()) AND (org_id = current_org_id()))`.

No policy change required. Item was based on a stale assumption; production state is correct.

---

## current_org_id() limit-1 assumption — deferred multi-org (2026-05-28)

`current_org_id()` body:
```sql
select org_id from org_members where user_id = auth.uid() limit 1;
```
No `ORDER BY` — would return an arbitrary org for any user belonging to more than one org, silently scoping that user to the wrong tenant.

**Current mitigation:** `UNIQUE (user_id)` constraint added to `org_members` in migration_m2e (applied 2026-05-28), enforcing one-org-per-user at the DB level. Zero violators existed at time of apply.

**To support multi-org users:**
1. `ALTER TABLE org_members DROP CONSTRAINT org_members_user_id_key;`
2. Replace the `limit 1` lookup in `current_org_id()` with request-context org resolution — either a JWT claim (e.g. `auth.jwt() ->> 'org_id'`) or a `SET LOCAL` session variable set by the API layer on each request.
3. Audit all 29 RLS policies that call `current_org_id()` to confirm they remain correct under per-request resolution.

**Triggers:** First client requiring one user account across multiple orgs.

---

## Pre-commit React import discipline

React imports must match all hook calls in the file before committing. This was missed in the M2 App.jsx split (Component added mid-commit). Candidate for a lint rule (`eslint-plugin-react-hooks`) or a pre-commit hook that checks `import React` vs hook usage.

**Triggers:** Next time App.jsx is split across commits, or when a linting pass is scheduled.
