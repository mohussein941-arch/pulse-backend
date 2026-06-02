# Pulse — CS Brain Roadmap

**Status:** CANONICAL — supersedes `pulse-ai-roadmap.md` and `ROADMAP_GAP_ANALYSIS.md`
**Date:** 2026-06-02
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

---

## Foundation — what is built today

| Capability | State | Notes |
|---|---|---|
| Auth + multi-tenancy | **Done** | JWT via `requireUser`; `org_id` enforced and isolation-tested |
| M1 Context Engine substrate | **Done** | `interactions`, `interaction_embeddings`, `ai_traces`, `llm` service (classify/reason/embed, server-side keys), cost tracking, feedback collection |
| Embedding worker | **Done, live** | In-process + 30s poll; has run live against OpenAI (7/7 interactions embedded) |
| `getContext()` retrieval | **Built, 1 caller** | 6-stage hybrid pipeline; called only by closeout |
| `reason()` cited synthesis | **Built, awaiting consumers** | Narrative-synthesis primitive (prose + citation IDs); serves M4.2 health narrative and M7 catch-me-up, not structured features. 0 callers is expected until those ship |
| Ingestion engines | **Done** | Fireflies → `call_transcript`, Gmail → `email_thread`, calendar → `calendar_event` |
| Email OAuth (Gmail send) | **Done** | Encrypted tokens; one-primary-per-user enforced at DB level |
| M3 Post-meeting closeout | **Shipped** | Uses `getContext` (retrieval) but NOT `reason` (no citations); writes health_signal/internal_note interactions, tasks, audit_log |
| Daily briefing | **Partial** | Rule-scored `briefing_items` (77 rows) + LLM narrative via legacy BYOK — bypasses the engine |
| Account Brief | **Built, server-side** | Full pipeline: server-side key, 6-key 24h cache, schema validation + retry, `ai_traces` cost tracking; frontend panel live with lazy fetch. Only gap: retrieves by recency, not via `getContext` |
| Outreach + digest engines | **Built, dormant** | Tables, runners, CRUD+send all exist; 0 rows; never switched on |
| HubSpot CRM read-sync | **Built, real, not live** | Real OAuth + API-key sync (companies + Service Hub tickets) via `src/connectors`; region-aware. Read-only. Writes to `accounts`, NOT to the timeline. 0 rows configured in prod |

### Known gaps in the foundation
- **HubSpot data never reaches the brain.** The read-sync is real, but it writes to `accounts` (`source: hubspot` / `hubspot_service`), not to `interactions` as `crm_event`. The Context Engine is blind to CRM signals — zero `crm_event` interactions exist. For a CS brain, this is a real gap: the brain can't retrieve or reason over CRM data.
- **Two disconnected health mechanisms.** CRM sync computes an account `health_score` via `calcHealth()` from NPS/CES/usage/tickets at sync time. Separately, closeout writes `health_signal` interactions that nothing aggregates. Neither feeds the other; there is no single synthesized health model.
- **CRM write-back does not exist.** Reading from HubSpot is real; writing back (deal stage, notes) is the only genuinely greenfield CRM piece. Closeout's "accept CRM update" writes an `internal_note` interaction, not to HubSpot.
- **Frontend sync trigger may be disconnected (verify).** A prior frontend-only analysis found the "Sync now" button wired to a placeholder modal while the real `/api/sync/run` call sat in dead code. The backend is real and callable; the UI path to trigger it needs confirming.

---

## Go-forward milestones

M1–M3 numbering is preserved (they are real, shipped, and referenced in code/docs). M4 onward is renumbered cleanly to end the old conflict, and resequenced by dependency rather than copied from either prior doc.

### Milestone 0 — Connect the brain *(prerequisite for the brain-visible features)*

`getContext` is the universal retrieval primitive — every feature needing account history should retrieve through it. `reason()` is the narrative-synthesis primitive, and its consumers are the free-text features (M4.2 health narrative, M7 catch-me-up); structured features (brief, closeout) retrieve via `getContext` and generate with their own validated prompts. Closeout already follows this pattern, and the Account Brief already runs on a server-side key, cached and cost-traced — so "connect the brain" is a short list, not a rebuild.

- **0.1 — Account Brief retrieves via `getContext`.** Today `briefGenerator.loadContext` pulls the 20 most recent interactions by date — pure recency. Swap that for a `getContext` call shaped like closeout's (lines 215–221), so the brief is relevance-ranked and surfaces important older context the recency window drops. Keep the structured prompt, schema validation, 6-key cache, and cost tracing untouched. *Invisible until accounts carry real history; pairs with 0.2.*
- **0.2 — Route HubSpot sync into the timeline (`crm_event`).** The connector output lands in `accounts` today; also write it through `writeInteraction({ source: 'crm_event' })` so CRM companies and tickets become retrievable timeline signals. This is the new signal that makes 0.1 visible — once CRM data flows in, the brief's `getContext` can surface it. Reuses an integration that already works.
- **0.3 — Retire or migrate briefing-summary BYOK.** The daily briefing narrative (`/api/ai/briefing-summary`) is the lone remaining legacy BYOK feature. Migrate it onto the engine, OR fold it into the Priority Queue (M5) and sunset it. Decide at M5 scope time.

Closeout already retrieves via `getContext` and generates with a validated prompt; no change needed there.

### Milestone 4 — Health synthesis + narrative

The brain turns logged signals into a living account-health model and explains it.

- **4.1 — Health synthesis.** Aggregate `health_signal` interactions + CES + usage into a computed account health score and trend. Closes the "signals in, nothing out" gap. Prerequisite for a credible priority queue.
- **4.2 — Health narrative.** `getContext`-based plain-language "why this account's health is what it is, and where it's heading."

### Milestone 5 — Priority queue *(the co-CSM core)*

The defining CS-brain feature and the heart of the "co-CSM" vision: a nightly cross-account scoring job that produces a ranked "who needs attention today, why, and the suggested first action." Supersedes the daily briefing as the CSM's home screen.

- **5.1 — Cross-account scoring job.** Composite "needs attention" score per account per CSM, fed by health synthesis (M4) + engine retrieval. Reuses the existing nightly automation cron substrate.
- **5.2 — "Today" view.** Ranked accounts, each with one reason and one suggested first action. The existing briefing page already half-implements the ranked-list UX; evolve it rather than build a redundant page.
- **5.3 — Activate the dormant outreach queue.** Wire it as the action surface — drafts generated via `reason()`, accept/edit/send. The plumbing already exists at 0 rows.

### Milestone 6 — Playbook recommendations

The brain recommends plays with rationale. Augment the existing rule-based `triggerCondition` predicates (cheap, instant) with engine-generated rationale and non-obvious matches — do not replace them.

### Milestone 7 — Institutional memory

The moat. "Catch me up on Acme" natural-language retrieval over the full timeline; AI-generated CSM-to-CSM handoff packets (distinct from the existing sales HandoverPage). Depends on accumulated data and everything above.

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
- Smoke-test seed cleanup before public demos.

---

## Decisions needed

1. **CRM write-back (the only greenfield CRM piece): build now or post-launch?** Read-sync is already real. Write-back (push deal stage / notes to HubSpot) is the missing direction. *Architect recommendation: post-launch and customer-triggered — read-sync plus feeding the brain (M0.2) is the higher-value work first.*
2. **briefing-summary at M5: migrate onto the engine, or sunset in favor of the Priority Queue?** Decide when scoping M5.
3. **Channel expansion trigger.** Confirm it stays horizontal/customer-driven rather than entering the M4–M7 sequence.

---

## Superseded documents

- `pulse-ai-roadmap.md` — lean capability ladder; engine build, no brain vision past M4.
- `ROADMAP_GAP_ANALYSIS.md` — frontend-only, pre-M1; brain vision but stale status data.

Both should carry a one-line "SUPERSEDED — see this document" header and be retained for history only.
