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

The brain is built but mostly unused. The Context Engine's retrieval half (`getContext`) feeds exactly one feature (closeout). Its reasoning/citation half (`reason`) has zero callers. The briefing and brief surfaces still run on the legacy BYOK path, bypassing the engine entirely. Every milestone below is sequenced so that the brain stops being dead weight and starts powering features.

---

## Foundation — what is built today

| Capability | State | Notes |
|---|---|---|
| Auth + multi-tenancy | **Done** | JWT via `requireUser`; `org_id` enforced and isolation-tested |
| M1 Context Engine substrate | **Done** | `interactions`, `interaction_embeddings`, `ai_traces`, `llm` service (classify/reason/embed, server-side keys), cost tracking, feedback collection |
| Embedding worker | **Done, live** | In-process + 30s poll; has run live against OpenAI (7/7 interactions embedded) |
| `getContext()` retrieval | **Built, 1 caller** | 6-stage hybrid pipeline; called only by closeout |
| `reason()` cited synthesis | **Built, 0 callers** | Finished code wired to nothing |
| Ingestion engines | **Done** | Fireflies → `call_transcript`, Gmail → `email_thread`, calendar → `calendar_event` |
| Email OAuth (Gmail send) | **Done** | Encrypted tokens; one-primary-per-user enforced at DB level |
| M3 Post-meeting closeout | **Shipped** | Uses `getContext` (retrieval) but NOT `reason` (no citations); writes health_signal/internal_note interactions, tasks, audit_log |
| Daily briefing | **Partial** | Rule-scored `briefing_items` (77 rows) + LLM narrative via legacy BYOK — bypasses the engine |
| Account Brief panel | **Partial** | Frontend shipped; `briefs` table exists; generation path does NOT go through `getContext`/`reason` |
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

### Milestone 0 — Connect the brain *(prerequisite for everything below)*

Make "AI feature" mean one thing: `getContext` → `reason` → cited output → `ai_traces` cost row. Retire the legacy BYOK path as features migrate onto the engine.

- **0.1 — Account Brief through the engine.** Back the already-built Brief panel with `getContext` + `reason` (cited, server-side key, cost-tracked). This completes M2 *properly* and is the first feature to use both halves of the brain. Highest existing scaffolding, lowest new surface area — the right first proof.
- **0.2 — Closeout gets the reasoning layer.** Closeout already retrieves via `getContext`; add `reason()` so its output is cited and auditable like every other engine feature.
- **0.3 — Retire BYOK for briefing-summary.** Migrate it onto the engine, OR deliberately fold it into the Priority Queue (M5) and sunset it. Decision at M5 scope time.
- **0.4 — Route HubSpot sync into the timeline.** The connector output already lands in `accounts`; also write it through `writeInteraction({ source: 'crm_event' })` so CRM companies and tickets become retrievable, reason-able timeline signals. This is what makes the brain CRM-aware, and it reuses an integration that already works.

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

1. **CRM write-back (the only greenfield CRM piece): build now or post-launch?** Read-sync is already real. Write-back (push deal stage / notes to HubSpot) is the missing direction. *Architect recommendation: post-launch and customer-triggered — read-sync plus feeding the brain (M0.4) is the higher-value work first.*
2. **briefing-summary at M5: migrate onto the engine, or sunset in favor of the Priority Queue?** Decide when scoping M5.
3. **Channel expansion trigger.** Confirm it stays horizontal/customer-driven rather than entering the M4–M7 sequence.

---

## Superseded documents

- `pulse-ai-roadmap.md` — lean capability ladder; engine build, no brain vision past M4.
- `ROADMAP_GAP_ANALYSIS.md` — frontend-only, pre-M1; brain vision but stale status data.

Both should carry a one-line "SUPERSEDED — see this document" header and be retained for history only.
