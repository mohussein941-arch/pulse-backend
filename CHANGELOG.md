# Changelog

## M2a — Ingestion plumbing (branch: m2a-ingestion)

### Security fixes

**OAuth state CSRF hardening** (`src/routes/emailAuth.js`, `src/routes/calendarAuth.js`)

Previously, the Gmail and Outlook OAuth callback routes validated the `state` parameter with only a basic length check (`state.length >= 10`). This allowed an attacker who obtained a valid OAuth authorization code to route it to an arbitrary user ID by crafting the callback URL.

Fixed by replacing the raw user ID in `state` with an HMAC-SHA256 signed token:
- Payload: `userId + timestamp`
- Signature: HMAC-SHA256 keyed on `ENCRYPTION_KEY`, truncated to 32 hex chars
- Expiry: 10 minutes (OAuth flows should complete well within this window)
- Constant-time comparison via `crypto.timingSafeEqual` prevents timing attacks

Applied to Gmail, Outlook, and the new Google Calendar OAuth flows.

### Gmail scope extension

`GMAIL_SCOPES` in `src/routes/emailAuth.js` previously included only `gmail.send`. Added `gmail.readonly` to enable reading message bodies for the Context Engine ingestion pipeline.

Existing connected Gmail accounts will need to re-authorise to grant the new scope. The sync engine detects insufficient scope errors and logs them without crashing.

### Gmail ingestion pipeline — interactions table

`src/engine/gmailIngestion.js` now writes to the `interactions` table (source: `email_thread`) in addition to the existing `email_threads` upsert (preserved for backward compatibility with existing UI consumers).

Changes:
- Fetches full message body (`format: 'full'`) instead of metadata-only
- Strips quoted reply text using standard patterns before indexing
- Strips HTML tags for HTML-only messages (logs each strip with interaction ID for retrieval quality auditing)
- Truncates content at 8,000 tokens (logs each truncation with interaction ID)
- Bridges `userId → orgId` via `org_members` lookup for org-scoped interaction writes
- Uses `external_id: 'gmail:{threadId}'` for idempotent re-sync

### Fireflies ingestion pipeline — interactions table

`src/engine/firefliesIngestion.js` now writes to the `interactions` table (source: `call_transcript`) in addition to the existing `meeting_notes` upsert.

Changes:
- GraphQL query extended to include `sentences { raw_words speaker_name }` for full transcript body (falls back to summary if empty)
- Transcript body built as `[Speaker]: text` format, truncated at 8,000 tokens
- Uses `external_id: 'fireflies:{id}'` for idempotent re-sync

### Google Calendar integration (new)

New OAuth flow (`src/routes/calendarAuth.js`) and sync engine (`src/engine/calendarIngestion.js`):
- Scope: `calendar.readonly`
- Tokens stored in `email_accounts` with `provider = 'google_calendar'`
- Detects customer meetings by matching event attendees against org stakeholders
- Writes to `interactions` table (source: `calendar_event`, `occurred_at` = meeting start time)
- Skips cancelled events at ingest time
- Uses `external_id: 'gcal:{eventId}'` for idempotent re-sync
- Calendar cancellation reconciliation (updating existing interaction when event is cancelled) is deferred — see TECH_DEBT.md

### OpenAI embedding activation

The embedding worker (`src/services/context-engine/embedding.js`) was already structurally correct from M1. M2a activates it by confirming `OPENAI_API_KEY` is set in production. The server already guards: `if (process.env.OPENAI_API_KEY) { startEmbeddingWorker(); }`.

### Schema changes

Migration `supabase/migration_m2a.sql`:
- Added `calendar_event` to `interactions.source` CHECK constraint
- Added `UNIQUE INDEX idx_interactions_org_external ON interactions(org_id, external_id) WHERE external_id IS NOT NULL` for deduplication across re-syncs
