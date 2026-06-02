# Pulse — CS Brain Roadmap

**Status:** CANONICAL — supersedes `pulse-ai-roadmap.md` and `ROADMAP_GAP_ANALYSIS.md`
**Date:** 2026-06-03
**Owner:** Mohamed (architect/reviewer); Claude Code (implementer)

---

## Why this document exists

Three scope shifts left two conflicting roadmaps in the repo:

1. **AI as BYOK briefing only.** The first AI feature was the daily briefing summary, built on a per-user bring-your-own-key model (`src/utils/ai.js` → `/api/ai/briefing-summary`).
2. **Embedded AI, no BYOK.** Key-management friction made BYOK untenable, so AI moved to server-side keys. This is when the Context Engine (M1) was built — `classify` / `reason` / `embed` on Anthropic + OpenAI keys held by Pulse, with cost tracking and multi-tenancy.
3. **Full CS brain.** The ambition grew from "AI helps with one screen" to "AI is the proactive intelligence underneath every screen."

`ROADMAP_GAP_ANALYSIS.md` captured the brain vision but predates the M1 build (it lists M1 at 5%). `pulse-ai-roadmap.md` captured the engine build but never absorbed the brain ambition past M4. This document reconciles both: the brain vision is the truth, re-grounded in what is actually built today, resequenced by dependency.

**The product in one line:** Pulse is a CS brain. It ingests every customer signal into one timeline, and proactively tells a CSM what needs attention, why, and what to do next — synthesized, cited, cost-tracked, and (eventually) in the customer's language.

---

## The core problem this roadmap fixes

The brain is partly adopted, not abandoned. `getContext` (retrieval) already powers closeout and should be extended to the Account Brief, which today retrieves by recency rather than relevance. `reason()` (narrative synthesis) is built ahead of its consumers — the health narrative (M4.2) and catch-me-up (M7) — so its zero callers is expected, not neglect. The one genuine legacy bypass is the daily briefing-summary, still on per-user BYOK. And no CRM signal reaches the timeline at all. Milestone 0 closes these specific gaps; everything after assumes the brain is the substrate.

**Update 2026-06-03:** M0.1 and M0.2 are complete — the Account Brief now retrieves via `getContext`, and HubSpot sync writes `crm_event` interactions to the timeline. M4–M7 are also complete (backend). The lone open item from this list is M0.3 (legacy BYOK briefing-summary).

---

## Foundation — what is built today

| Capability | State | Notes |
|---|---|---|
| Auth + multi-tenancy | **Done** | JWT via `requireUser`; `org_id` enforced and isolation-tested |
| M1 Context Engine substrate | **Done** | `interactions`, `interaction_embeddings`, `ai_traces`, `llm` service (classify/reason/embed, server-side keys), cost tracking, feedback collection |
| Embedding worker | **Done, live** | In-process + 30s poll; has run live against OpenAI (7/7 interactions embedded) |
| `getContext()` retrieval | **Done, 7+ callers** | 6-stage hybrid pipeline; powers Account Brief (M0.1), closeout, health narrative (M4.2), outreach drafting (M5.3), catch-up (M7.1), handoff (M7.2). Proven live — real interactions returned |
| `reason()` cited synthesis | **Done, 4 callers** | Narrative-synthesis primitive (prose + citation IDs); consumed by health narrative (M4.2), catch-up (M7.1), handoff (M7.2). Outreach uses `llm.reason` directly (not `reason()` — citation markers wrong for customer-facing email) |
| Ingestion engines | **Done** | Fireflies → `call_transcript`, Gmail → `email_thread`, calendar → `calendar_event` |
| Email OAuth (Gmail send) | **Done** | Encrypted tokens; one-primary-per-user enforced at DB level |
| M3 Post-meeting closeout | **Shipped** | Uses `getContext` (retrieval) but NOT `reason` (no citations); writes health_signal/internal_note interactions, tasks, audit_log |
| Daily briefing | **Partial** | Rule-scored `briefing_items` + LLM narrative via legacy BYOK — bypasses the engine. M0.3 (migration/sunset) is the remaining open item |
| Account Brief | **Done** | Full pipeline: server-side key, 6-key 24h cache, schema validation + retry, `ai_traces` cost tracking, `getContext` retrieval (M0.1). Frontend panel live |
| Outreach + digest engines | **Live, proven** | M5.3 activated; runner queued 6 `ai_generated:true` drafts after `daysSince` bugfix; `org_id` present, 0 template fallback |
| HubSpot CRM read-sync | **Done** | Real OAuth + API-key sync (companies + Service Hub tickets); M0.2 complete — also writes `crm_event` interactions to the timeline so CRM signals are brain-retrievable |

### Known gaps in the foundation

- **CRM write-back does not exist.** Reading from HubSpot is real, and CRM data now flows into the timeline (M0.2). Writing back (deal stage, notes to HubSpot) is the only genuinely greenfield CRM piece. Closeout's "accept CRM update" writes an `internal_note` interaction, not to HubSpot. *Decision: post-launch and customer-triggered — see Decisions section.*
- **Frontend sync trigger may be disconnected (verify).** A prior frontend-only analysis found the "Sync now" button wired to a placeholder modal while the real `/api/sync/run` call sat in dead code. The backend is real and callable; the UI path to trigger it needs confirming.

---

## Go-forward milestones

M1–M3 numbering is preserved (they are real, shipped, and referenced in code/docs). M4 onward is renumbered cleanly to end the old conflict, and resequenced by dependency rather than copied from either prior doc.

### Milestone 0 — Connect the brain **✓ DONE** *(0.3 pending)*

`getContext` is the universal retrieval primitive — every feature needing account history should retrieve through it. `reason()` is the narrative-synthesis primitive, and its consumers are the free-text features (M4.2 health narrative, M7 catch-me-up); structured features (brief, closeout) retrieve via `getContext` and generate with their own validated prompts. Closeout already follows this pattern, and the Account Brief already runs on a server-side key, cached and cost-traced — so "connect the brain" is a short list, not a rebuild.

- ✓ **0.1** `b84e5e7` — Account Brief retrieves via `getContext` on cache-miss; falls back to recency. Brief is now relevance-ranked and surfaces important older context the recency window drops.
- ✓ **0.2** `4649ee6` — HubSpot sync writes `crm_event` interactions to the timeline; CRM signals are now retrievable by the Context Engine.
- **0.3 — Retire or migrate briefing-summary BYOK.** The daily briefing narrative (`/api/ai/briefing-summary`) is the lone remaining legacy BYOK feature. Migrate it onto the engine, OR fold it into the Priority Queue (M5) and sunset it. *M5 is now complete — decide when scoping the next frontend phase.*

Closeout already retrieves via `getContext` and generates with a validated prompt; no change needed there.

### Milestone 4 — Health synthesis + narrative **✓ DONE**

The brain turns logged signals into a living account-health model and explains it.

- ✓ **4.1** `5289022` — `healthSynthesis.js` (`synthesizeHealth` — DB-only trend/momentum from `health_signal` interactions + history) + `GET /accounts/:id/health-synthesis`; augments `calcHealth`. Closes the "two disconnected health mechanisms" gap.
- ✓ **4.2** `ef61157` — `healthNarrative.js` (`synthesizeHealth` + `getContext` + `reason`) + `GET /accounts/:id/health-narrative` — first consumer of `reason()`.

### Milestone 5 — Priority queue *(the co-CSM core)* **✓ DONE**

The defining CS-brain feature and the heart of the "co-CSM" vision: a nightly cross-account scoring job that produces a ranked "who needs attention today, why, and the suggested first action." Supersedes the daily briefing as the CSM's home screen.

- ✓ **5.1** `7a2f924` — `briefingRunner` emits `health_declining` signal (base 6) from `synthesizeHealth` trend; `accounts` SELECT gains `org_id`. Priority queue is now trend-aware.
- ✓ **5.2a** `d5705d4` — `GET /briefing/priority` — ranked accounts (top signal per account) + rule-based `suggested_action`; canonical account-ranked source for digest/outreach (not consumed by frontend directly).
- ✓ **5.2b** `268437c` (backend) / `8adfeb2` (frontend) — `shapeItem` exposes `suggestedAction` (null for wins); existing `ActionCard` renders the suggested-action line.
- ✓ **5.3** `596115b` — AI-drafted outreach — `buildOutreachDraft` (`getContext` + `llm.reason` bespoke prompt → `{subject,body}`, `ai_generated:true`, template fallback); fixed latent missing `org_id` insert; `accounts` SELECT gains `org_id`.

### Milestone 6 — Playbook recommendations **✓ DONE**

The brain recommends plays with rationale. Augments the existing rule-based `triggerCondition` predicates (cheap, instant) with engine-generated rationale and non-obvious matches — does not replace them.

- ✓ **6.1** `1a8d089` — `playbookRecommender.js` (`recommendPlaybook` — trend-aware decision tree → specific play from `playbooks` table, with reason) + `GET /accounts/:id/recommended-playbook`.
- ✓ **6.2** `6b57ea0` — `playbook_suggested` outreach drafts name the specific recommended play.

### Milestone 7 — Institutional memory **✓ DONE**

The moat. "Catch me up on Acme" natural-language retrieval over the full timeline; AI-generated CSM-to-CSM handoff packets (distinct from the existing sales HandoverPage). Depends on accumulated data and everything above.

- ✓ **7.1** `3fb0cba` — `catchUp.js` (`generateCatchUp` — `getContext` broad + `reason` recap) + `GET /accounts/:id/catch-up`.
- ✓ **7.2** `85dfede` — `handoffPacket.js` (`generateHandoffPacket` — assembles `synthesizeHealth` + `recommendPlaybook` + `generateCatchUp` + stakeholders + open tasks + active/recommended play) + `GET /accounts/:id/handoff`.

---

## Build log + verification

### 2026-06-03 — M0 / M4 / M5 / M6 / M7 backend complete

#### Completed this session

| Milestone | Hash | Outcome |
|---|---|---|
| M0.1 | `b84e5e7` | Account Brief retrieves via `getContext` on cache-miss; falls back to recency |
| M0.2 | `4649ee6` | HubSpot sync writes `crm_event` interactions to the timeline |
| M4.1 | `5289022` | `healthSynthesis.js` — DB-only trend/momentum + `GET /accounts/:id/health-synthesis` |
| M4.2 | `ef61157` | `healthNarrative.js` — `getContext` + `reason()` + `GET /accounts/:id/health-narrative` |
| M5.1 | `7a2f924` | `briefingRunner` emits `health_declining` trend signal; `accounts` SELECT gains `org_id` |
| M5.2a | `d5705d4` | `GET /briefing/priority` — ranked accounts + rule-based `suggested_action` |
| M5.2b | `268437c` / `8adfeb2` | `shapeItem` exposes `suggestedAction`; `ActionCard` renders it |
| M5.3 | `596115b` | AI-drafted outreach via `getContext` + `llm.reason`; fixed `org_id` insert |
| M6.1 | `1a8d089` | Trend-aware playbook recommender + `GET /accounts/:id/recommended-playbook` |
| M6.2 | `6b57ea0` | `playbook_suggested` outreach drafts name the specific recommended play |
| M7.1 | `3fb0cba` | Catch-up recap endpoint (`getContext` broad + `reason`) |
| M7.2 | `85dfede` | Handoff packet endpoint (assembles all brain outputs) |
| BUGFIX | `2152181` | Hoist `daysSince`/`daysUntil` to module scope in `outreachRunner.js` — was a ReferenceError crashing the runner on any champion-less account; main reason `outreach_queue` stayed empty |

#### Verification — 2026-06-03

- **Pass 1** (`tools/smoke_brain.cjs`, read-only): all brain functions execute cleanly; `getContext` retrieval is LIVE (returned real interactions, embeddings working); narratives grounded + cited; `recommendPlaybook` + `handoffPacket` assemble correctly.
- **Pass 1b** (`tools/smoke_outreach.cjs`): after the `daysSince` fix, runner queued 6 drafts — all `ai_generated:true`, all `org_id` present, 0 template fallback. Outreach write path proven.
- **Verdict:** backend brain proven end to end (read + write). One pre-existing runner-crashing bug found and fixed.

#### Decisions / refinements recorded

- Outreach drafting uses `llm.reason` (bespoke Sonnet primitive, cost-traced) + `getContext` — NOT the `reason()` citation wrapper, since citation markers are wrong for a customer-facing email.
- M6 scoped as thin backend (recommender + outreach integration). Playbook recommendation already existed in three places (frontend `triggerCondition` closures, brief `playbooks` field, outreach `playbook_suggested`); M6 adds the brain-grounded, trend-aware source. Rewiring the frontend closures to that single source is DEFERRED (optional consolidation).
- M5.2b enhanced existing `ActionCard`s instead of a redundant new priority section.

---

## Open tracks *(as of 2026-06-03)*

### Frontend surfacing *(highest priority; none have UI yet)*

- Catch-up (`GET /accounts/:id/catch-up`) — no frontend surface
- Handoff packet (`GET /accounts/:id/handoff`) — no frontend surface
- Health narrative (`GET /accounts/:id/health-narrative`) — no frontend surface
- Recommended playbook (`GET /accounts/:id/recommended-playbook`) — no frontend surface
- Confirm M5.2b `suggestedAction` renders correctly in the live app

*Approach:* `App.jsx` is large and fragile — surface one endpoint at a time.

### Fast-follows

- Health-narrative caching if call frequency increases (currently uncached; `getContext` + `reason()` on every call)
- Outreach lazy-drafting (cost) once account volume grows — runner currently drafts eagerly every 6h

### Optional consolidation

- Rewire frontend `triggerCondition` playbook closures → `recommendPlaybook` (single brain-grounded source). Low priority; current state works.

### Unexercised paths

- M6.2 `playbook_suggested` draft path did not fire during smoke (no `playbook_suggested` signal queued at smoke time). Low-risk — code path is straightforward; needs a live signal to exercise end-to-end.

---

## Horizontal capabilities *(not sequential milestones)*

- **Channel expansion (Wati / Slack / tickets).** Feeds more signal into the brain. Greenfield builds plus Arabic-NLP research — deliberately pulled OUT of the critical path. Build a specific channel only when a target customer needs it; otherwise it blocks the brain for research work.
- **Arabic / cultural layer.** Language detection, per-stakeholder tone, KSA/UAE weekend + Ramadan awareness. Built into each feature as it ships, not a separate phase.
- **Cost discipline.** Every engine call already writes `ai_traces`; keep `FEATURE_BUDGETS` honest as features migrate onto the engine.

---

## Pre-launch hygiene track *(gates real customers, not part of the brain)*

These don't build the brain but block onboarding a real customer:

- Supabase API key system migration (legacy JWT keys → `sb_secret_` / `sb_publishable_`); includes service-role rotation. (Was "Session F".)
- Git-history scrub of the old `VITE_API_SECRET=pulse-secret-mohamed-2026` value committed in `536e3dd`.
- Smoke-test seed cleanup before public demos or customer onboarding: remove the 6 smoke outreach drafts queued by `tools/smoke_outreach.cjs`, the `tools/smoke_brain.cjs` and `tools/smoke_outreach.cjs` scripts, and the "Smoke Test Co" account.

---

## Decisions needed

1. **CRM write-back (the only greenfield CRM piece): build now or post-launch?** Read-sync is real and CRM data now flows into the timeline (M0.2). Write-back (push deal stage / notes to HubSpot) is the missing direction. *Architect recommendation: post-launch and customer-triggered — read-sync plus feeding the brain is the higher-value work first.*
2. **M0.3 — briefing-summary BYOK: migrate onto the engine, or sunset in favor of the Priority Queue?** M5 is now complete; decide when scoping the next frontend phase.
3. **Channel expansion trigger.** Confirm it stays horizontal/customer-driven rather than entering the M4–M7 sequence.

---

## Status

**M0 ✓  M4 ✓  M5 ✓  M6 ✓  M7 ✓** — brain build feature-complete (backend), verified end to end.
Remaining: frontend surfacing (catch-up, handoff, health-narrative, recommended-playbook) + pre-launch hygiene.

---

## Superseded documents

- `pulse-ai-roadmap.md` — lean capability ladder; engine build, no brain vision past M4.
- `ROADMAP_GAP_ANALYSIS.md` — frontend-only, pre-M1; brain vision but stale status data.

Both should carry a one-line "SUPERSEDED — see this document" header and be retained for history only.
