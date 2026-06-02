> SUPERSEDED 2026-06-02 — see pulse-backend/ROADMAP.md (canonical CS Brain Roadmap). Retained for history only.

# Pulse AI Roadmap

Last updated: 2026-05-24

---

## M1 — Context Engine substrate ✅ COMPLETE

**Branch:** `m1-context-engine` → merged to `main`  
**Validation:** `docs/M1_VALIDATION.md`

What shipped:
- `interactions` table — unified timeline for all customer signals
- `interaction_embeddings` — 1536-dim vectors (text-embedding-3-small), async worker
- `ai_traces` — every LLM call logged with cost and latency from day one
- `services/llm` — classify / reason / embed provider abstraction
- `services/context-engine` — ingestion, embedding, retrieval, reasoning, feedback
- `getContext()` 6-stage hybrid retrieval pipeline (keyword + vector, merged ranking)
- Multi-tenancy isolation: org_id enforced at every SQL stage, tested by isolation script
- Backfill script: legacy meeting_notes, email_threads, activity_log → interactions
- `POST /api/ai/feedback` — accept/edit/reject signal collection for M7+

**One deferred item:** Embedding worker live OpenAI API execution (static code verified correct; live run deferred to M2 gate). See `docs/M1_VALIDATION.md §5b`.

---

## M2 — Pre-meeting brief ⬜ NOT STARTED

**Depends on:** M1 (interactions + getContext)  
**Target:** Session TBD

What will ship:
- `GET /api/briefing/:accountId/pre-meeting` — generates a structured brief
- Calls `getContext()` for relevant account history
- Calls `reason()` to synthesise brief sections (last interaction, open risks, talking points)
- Brief stored to `briefing_items` table (requires M0b workload table migration first — see TECH_DEBT.md)
- Front-end "Prep" panel for CSMs

**M2 Step 0 gate:** Embedding worker must successfully embed at least 10 interactions before brief generation test is run. This completes the Step 5b validation deferred from M1.

---

## M3 — Post-meeting closeout ⬜ NOT STARTED

**Depends on:** M1, M2  
**Target:** Session TBD

What will ship:
- `POST /api/meetings/:id/closeout` — takes meeting notes, generates close-out summary
- Writes new `call_transcript` interaction via `writeInteraction()`
- Drafts follow-up tasks (stored to `tasks` table)
- Updates account health signal if sentiment is detected
- Outreach draft written to `outreach_queue` (requires M0b workload table migration)

---

## M4 — Health narrative ⬜ NOT STARTED

**Depends on:** M1  
**Target:** Session TBD

What will ship:
- `GET /api/accounts/:id/health-narrative` — explains the current health score in plain language
- Pulls recent health signals, CES scores, and call transcripts via `getContext()`
- Identifies trend direction (improving / stable / declining)
- Used in stakeholder digest emails (M5)

---

## M5 — Stakeholder digest ⬜ NOT STARTED

**Depends on:** M1, M4, M0b workload table migrations  
**Target:** Session TBD

What will ship:
- Scheduled digest runner generates per-account summaries for CSMs
- Pulls health narratives (M4) + open tasks + upcoming renewals
- Sends via Resend (upgrade from test address to real domain first — see production checklist)
- `digest_schedules` table must be org_id-migrated first (TECH_DEBT.md)

---

## M6 — Retrieval quality improvements ⬜ NOT STARTED

**Depends on:** Meaningful `ai_traces.feedback` signal from M2–M5 real usage

Candidates (pick based on feedback data):
- Chunk-level embedding rows (better long-doc passage retrieval)
- BM25 scoring via pg_bm25 / ParadeDB
- Per-org source weight tuning
- `search_interactions_text` RPC FTS upgrade (replaces ILIKE fallback)

---

## M7 — Model quality loop ⬜ NOT STARTED

**Depends on:** M6 (enough feedback data), M2–M5 in production

What will ship:
- Analysis pipeline over `ai_traces` feedback (accept/edit/reject rates per feature)
- Prompt iteration workflow
- A/B evaluation harness for prompt changes

---

## Architecture decisions

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](docs/ADR-001-retrieval-architecture.md) | Hybrid keyword + vector retrieval with composite ranking | Accepted (M1) |
