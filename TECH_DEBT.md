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

---

## SECURITY DEFINER functions — search_path audit (backlog)

m2f hardened current_org_id() with `SET search_path = ''` + fully-qualified references.
The same Supabase lint pattern (function_search_path_mutable) likely applies to other
user-defined SECURITY DEFINER functions in the schema. Enumerate and harden in a single
batch when convenient.

Audit query:

    SELECT n.nspname, p.proname, p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef = true
      AND n.nspname NOT IN ('pg_catalog','information_schema','auth','storage',
                            'realtime','supabase_functions','extensions','graphql',
                            'graphql_public','vault','pgsodium','pgsodium_masks',
                            'net','cron')
    ORDER BY n.nspname, p.proname;

For each row where proconfig does NOT include a search_path entry, apply the same
hardening pattern as m2f: pin search_path to empty, fully-qualify all schema references
in the function body.

**Triggers:** Next database-hardening tidy-up pass, or whenever Supabase dashboard
linter surfaces it.

---

## M3: promptVersionHash() unused in closeout cache model

`promptVersionHash()` in `closeoutPrompt.js` is exported but the closeout cache key is
`(org_id, meeting_notes_id)` + `prompt_version` string equality — not a hash tuple as in
M2's 6-tuple. The function is preserved for M2 engine parity. If it remains unwired by
v2 release, remove it.

**Triggers:** v2 engine review, or any future plan to switch the closeout cache to a
hash-based key.

---

## M3: loadContext logic duplicated between brief and closeout generators

`briefGenerator.js` (account, interactions, stakeholders, tasks, playbooks, csmProfile)
and `closeoutGenerator.js` (same minus interactions — closeout uses `getContext` for
that slot) share near-identical context loading code. Extract to
`src/engine/contextLoader.js` when convenient. Duplication is intentional per the
no-cross-engine-refactor rule during M3.

**Triggers:** Any third engine that needs the same context shape, or a scheduled M3
cleanup pass.

---

## M3: No automated tests for engine code (brief or closeout)

Verification is smoke-test only. Add unit tests with mocked Anthropic responses
post-M3 — particularly for retry-once semantics and cache invalidation on
`prompt_version` mismatch.

**Triggers:** First flaky smoke test, or before onboarding a second engineer to the
engine layer.

---

## Pre-launch: rotate exposed Supabase service-role key

`verify_phase4.cjs` (gitignored as of the prior chore commit) contained
a hardcoded Supabase service-role key in plaintext. The file is no
longer trackable, but the key value has been exposed to local disk,
Claude Code session memory, and chat logs. Acceptable risk during
solo-dev phase with no real user data; must be rotated before public
launch alongside other env-bundled secrets.

**Companion item:** API_SECRET hygiene refactor — `pulse/.env` is
tracked and `VITE_*` vars are bundled client-side, "looks secure,
isn't." Both keys should be rotated in the same pre-launch pass.

**Triggers:** Any plan to onboard a second user, ship to a paying
customer, or share the deployed app URL publicly.

---

## M3c: automationRunner writes lowercase priority, silently rejected by tasks_priority_check

`src/engine/automationRunner.js` writes `priority: cfg.priority || 'medium'`. The
DB CHECK constraint on `tasks.priority` requires Title Case (`'Critical'`,
`'High'`, `'Medium'`, `'Low'` after the M3c migration). Lowercase values still
fail the constraint and the runner's `insertErr` handling swallows the error —
automation-triggered tasks have been silently failing to insert in production.

**Fix:** capitalize `cfg.priority` before insert in `automationRunner.js`. One-line
change mirroring the m3c accept-tasks handler:
`priority.charAt(0).toUpperCase() + priority.slice(1)`. If the helper appears in
a third place, lift to a util.

**Triggers:** Next automation-rules review, or when ai_traces / audit logs show
zero successful `automation_task_created` events over a sustained period.

---

## M3d: dual link mechanism between interactions and meeting_notes

`closeoutGenerator.js:181-188` links a transcript to its meeting via
`.contains('metadata', { fireflies_id })` (JSONB match on the `metadata` column).
The `has_transcript` lookup added in `m3d.0` (`meetings.js` GET handler) links
the same relationship via `.in('external_id', ['fireflies:...'])` (indexed text
column match).

Both paths resolve the same logical relationship — "which interaction row
corresponds to this meeting_notes row" — through different storage columns. If
Fireflies ingestion ever changes one without the other (e.g. stops populating
`metadata.fireflies_id` but keeps `external_id`, or vice versa), the two call
sites will silently diverge: closeout generation and `has_transcript` will
disagree on whether a transcript exists for a given meeting.

**Long-term fix:** add a `meeting_notes_id` FK column to `interactions` and
migrate both call sites to use it. Pre-launch cleanup candidate.

**Triggers:** Any refactor of Fireflies ingestion, or before a second engineer
touches either `closeoutGenerator.js` or the meetings route.

## Modal Escape handler conflict — pre-existing, broader than m3d.1c fix

The `<Modal>` component (`pulse/src/App.jsx:686-709`) and `<Confirm>` component (lines 711-730) both register `window` keydown listeners that call their `onClose`/`onCancel` callbacks on Escape. The `Detail` component registers a similar listener that closes the entire account view. When any modal is open inside Detail and the user presses Escape, BOTH listeners fire: the modal closes AND Detail closes, ejecting the user to Portfolio.

`m3d.1c` patches the case for `closeoutMeeting` only. The bug remains for every other modal flag in Detail: `showStk`, `showEdit`, `showDel`, `showChurn`, `showCES`, `showPrep`, `showPortal`, `showEscalate`, and any `Confirm` invocation. Users typically don't notice because they close modals via the X button rather than Escape — but the bug is real and any keyboard-driven user or automated test will hit it.

Long-term fix options:
- Refactor `<Modal>` and `<Confirm>` to use `e.stopImmediatePropagation()` with `{ capture: true }` registration so they reliably fire before Detail's handler.
- Move modal-open state into a context that Detail's Escape handler can read to decide whether to skip.
- Replace `window` keydown listeners with focus-trap + element-scoped key handling.

Pre-launch polish candidate.

---

## Email account primary management — no UI to switch primary provider

No UI exists for users to switch the primary email account between connected providers. Currently first-account-wins via callback auto-promote: the OAuth callback promotes the freshly-connected account to primary only if no primary exists. Multi-account users (Gmail + Outlook) can only change their primary via `PATCH /api/email/accounts/:id/set-primary`, which is not wired into any UI.

**Triggers:** Pre-launch if multi-provider email becomes a real use case.

---

## Email account uniqueness — no DB-level enforcement of at-most-one-primary

`is_primary` uniqueness per user is enforced only by application logic in the OAuth callbacks. Nothing prevents two rows for the same `user_id` from both having `is_primary = true`, which would cause `.maybeSingle()` in `sendAutomationEmail` to throw.

**Fix:** Add a partial unique index: `CREATE UNIQUE INDEX email_accounts_one_primary_per_user ON email_accounts(user_id) WHERE is_primary = true;`

**Triggers:** Post-m3d, before multi-provider email is exposed to users.

---

## RESOLVED (Session A, commits 1b548b2 + 09514e4 + 235c2ed): M3d: per-action confirmation state local to CloseoutModal (m3d.2)

"Logged to account" (m3d.2) and forthcoming Accept/Send/Log affordances (m3d.3-5) don't persist across modal close/reopen, allowing duplicate submissions per closeout. Confirmation state is `useState` local to `CloseoutModal` and resets every time the modal is unmounted.

**Resolve** with server-tracked state (`closeouts.actions_taken` column, or derive on read from interactions) after m3d.3-5 scaffold so all four converge on one mechanism. (m3d.2)

- m3d.4: Email-send confirmation (`emailSent` flag) is reset on Regenerate, matching m3d.2/3 symmetry. Real consequence: a user can re-click Send after Regenerate and double-send a follow-up email. Fix as part of the post-m3d.5 per-action confirmation cross-cut — confirmation should be sticky for outbound-side-effect actions and hydrate from DB (e.g. by querying for an existing follow-up email interaction on this meeting_notes_id) on modal reopen.

---

## Duplicate refreshTokenIfNeeded implementations (emailAuth.js vs emailSender.js)

Two copies of `refreshTokenIfNeeded` exist:

- `src/routes/emailAuth.js` (~lines 432-490) — original, correctly calls `decrypt()` on tokens before use.
- `src/utils/emailSender.js` — previously missing all `decrypt`/`encrypt` calls; fixed in commit `fix(backend): emailSender — decrypt tokens on read, encrypt on refresh-write`.

Both implementations are now functionally correct, but any future logic change (e.g. a new provider, expiry window tuning, scope refresh) must be applied in both places or they will silently drift.

**Consolidation path:** Extract to `src/utils/oauthRefresh.js` (or keep in `emailSender.js` and have `emailAuth.js` import from it). The shared helper should own all decrypt-on-read / encrypt-on-write logic so there is one place to audit.

**Triggers:** Pre-launch refactor pass, or whenever either file needs a token-refresh behaviour change.

---

## M3d: /auth/refresh endpoint rejecting valid-looking refresh tokens

`pulse-backend /auth/refresh` route returns rejection for refresh tokens that appear valid by structure. Observed during m3d OAuth debugging; workaround is the user logs out and logs back in fresh (incognito clears cached token state).

Investigation sits in the same neighborhood as the `API_SECRET` hygiene refactor: both touch the token/auth layer and the root cause may be related to key rotation or secret mismatch across environments.

**Triggers:** Investigate alongside `API_SECRET` refactor (Session D). Surface if any user reports "logged out unexpectedly" or if auth error rate climbs in Railway logs.

---

## Session-expired error swallowed by re-render cascade (frontend)

When `call()` throws `"Session expired"` and `setSession(null)` cascades through App, the error toast either doesn't render or flashes for one frame. User receives no feedback on session expiry — the UI simply snaps to the logged-out state.

**Fix:** Add session-expiry-specific handling upstream of the re-render cascade, or wire a toast queue that survives component unmount. Alternatively, store the expiry message in a ref that the login screen can display on mount.

**Triggers:** Pre-launch UX polish, or first user report of "the app just logged me out with no message."

---

## m3d.2: root cause unexplained — formless navigation on button click

During m3d.2 debugging, the Health Signal "Log to account" button without `type="button"` caused clicks to navigate to Portfolio instead of firing the handler. Adding `type="button"` fixed it. No `<form>` ancestor was found in the JSX tree at debugging time; the mechanism by which a bare `<button>` (default type `"submit"`) triggered navigation without a surrounding form is still unexplained.

**Defensive rule established:** apply `type="button"` to all new buttons. Convention held through m3d.3/4/5 with no further occurrences.

**Triggers:** If the root cause is ever identified (React 19 event delegation quirk? stray form in portal?), document here. No action required otherwise.

---

## m3d.2: "✓ Logged" UI state anomaly — low priority, may be superseded

A UI state anomaly where "✓ Logged" appeared or persisted unexpectedly was observed during the m3d.2 saga. Specific reproduction steps were not captured in real time.

**Status:** Likely superseded by Session A's server-hydrated confirmation model. Worth re-checking once real CSM usage signal accumulates to confirm it doesn't recur under the new model.

**Triggers:** First CSM report of stale "✓ Logged" state, or a scheduled post-launch UX review.

---

## type="button" defensive audit across App.jsx

Convention established in m3d.2: all new buttons must carry `type="button"`. Propagated through m3d.3/4/5. Not yet audited across all pre-existing buttons in App.jsx.

**Fix:** One-time mechanical pass — grep for `<button` without `type=`, add `type="button"` where missing. Cheap; no logic changes.

**Triggers:** Next App.jsx refactor pass, or before onboarding a second frontend contributor.

---

## alignSelf without flex parent — cosmetic dead CSS

Three buttons in CloseoutModal carry `alignSelf: "flex-start"` without a flex parent container, making the rule inert:
- Accept button (m3d.3)
- Send button (m3d.4)
- Accept Tasks button (m3d.5)

No functional issue; purely cosmetic dead CSS.

**Fix:** Either remove the dead rule or convert the relevant section container to `display: flex` with intentional alignment.

**Triggers:** Next CloseoutModal styling pass.

---

## err.message surfacing convention — pre-launch audit

Established during m3d.4 OAuth debugging: surfacing `err.message` verbatim from backend responses via toast (instead of a generic "try again" message) was the decisive diagnostic affordance — turned a multi-day OAuth debug into a sequence of specific error strings (`invalid_grant`, `redirect_uri_mismatch`, "No connected email account").

Convention is established but not yet audited across all `catch` blocks handling backend calls in the frontend.

**Pre-launch audit:** every `catch` that handles a backend call should surface `err.message` with status-code overrides where appropriate (e.g. 402 → upgrade flow prompt rather than raw error string).

**Triggers:** Pre-launch hardening pass.

---

## CloseoutModal: "No tasks suggested" empty-state semantics

The Tasks section in CloseoutModal shows the same empty-state message whether the AI validator produced zero task suggestions OR the user manually removed all suggested tasks. A CSM cannot distinguish "Pulse had no suggestions for this meeting" from "I cleared all suggestions."

**Fix:** Track the two states separately — e.g. a `tasksWereGenerated` flag alongside the tasks array — and render distinct copy for each.

**Triggers:** First CSM report of confusion, or a scheduled post-launch UX review.

---

## CloseoutModal: due-in-days read-only in tasks editor

`due_in_days` is displayed as a read-only label per task row in the CloseoutModal Tasks section (m3d.5). The value comes from the AI suggestion and is not editable before accepting.

**Note:** Feature ask, not a bug. Deferred enhancement; revisit if user demand emerges.

**Triggers:** First CSM request to adjust due dates before accepting tasks.

---

## Session A: backfill imprecision in migration_session_a_tasks_meeting_notes_id.sql

The backfill logic in `migration_session_a_tasks_meeting_notes_id.sql` is global, not per-user: if multiple distinct `closeout.tasks_accepted` resource IDs exist in `audit_log` at migration time (ambiguous mapping), the **entire backfill is skipped** — zero rows are updated, leaving all closeout-source tasks with `meeting_notes_id = NULL`. There is no partial-skip branch; the guard is all-or-nothing.

**At Session A apply time:** confirmed only a single resource_id existed — backfill ran cleanly with zero NULL orphans introduced.

**Document for future migrations of this shape:** as additional closeout sessions accumulate audit rows, the all-or-nothing skip condition becomes increasingly likely to trigger. Any re-run of this backfill shape must confirm a single unambiguous resource_id beforehand, or adopt a different strategy (e.g. per-user resolution, or an explicit resource_id parameter).

**Triggers:** Any future migration touching `tasks.meeting_notes_id`, or if `meeting_notes_id IS NULL` rows appear in production after the Session A migration.
