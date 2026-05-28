// src/engine/briefPrompt.js
// Builds the pre-meeting brief prompt sent to Claude for synthesis.
// Bump BRIEF_PROMPT_VERSION whenever any static prompt text changes —
// the version is hashed into the cache key (prompt_version_hash) so stale
// cached briefs are automatically bypassed after a prompt update.

const crypto = require('crypto');

const BRIEF_PROMPT_VERSION = 'v4';
const BRIEF_MODEL = 'claude-sonnet-4-6';

function promptVersionHash() {
  return crypto.createHash('sha256').update(BRIEF_PROMPT_VERSION).digest('hex');
}

function buildBriefPrompt({ account, interactions, stakeholders, tasks, playbooks, csmProfile }) {
  const {
    career_stage  = 'mid',
    specialty     = 'general_csm',
    working_style = {},
  } = csmProfile || {};

  return `
You are a senior Customer Success intelligence assistant. Generate a concise, structured pre-meeting brief for a CSM who is about to meet with the account below.

## Account

Name: ${account.name}
Health score: ${account.health_score ?? 'unknown'}
Churn risk: ${account.churn_risk ?? 'unknown'}
Renewal date: ${account.renewal_date ?? 'none on record'}
Stage: ${account.stage ?? 'unknown'}
NPS: ${account.nps ?? 'none on record'}
CES: ${account.ces ?? 'none on record'}

## Stakeholders

${formatStakeholders(stakeholders)}

## Recent interactions

${formatInteractions(interactions)}

## Open tasks

${formatTasks(tasks)}

## Applicable playbooks

${formatPlaybooks(playbooks)}

## CSM profile

Career stage: ${career_stage}
${careerStageGuidance(career_stage)}

Specialty: ${specialty}

Working style: ${formatWorkingStyle(working_style)}

## Adapt focus to specialty

${specialtyGuidance(specialty)}

## Output format

Respond with a single JSON object. No markdown fences. No text before or after the JSON.

{
  "summary": "<string: 1–2 sentences on the account's current state>",
  "themes": [
    {
      "topic": "<string>",
      "sentiment": "positive" | "neutral" | "negative",
      "evidence": "<string: reference to a specific interaction from the Recent interactions section above>"
    }
  ],
  "talking_points": [
    {
      "point": "<string>",
      "rationale": "<string>"
    }
  ],
  "risks": [
    {
      "description": "<string | null>",
      "severity": "high" | "medium" | "low" | null,
      "owner": "<string | null: exact stakeholder name from the Stakeholders section, or null>"
    }
  ],
  "playbooks": [
    {
      "name": "<string: exact playbook name from the Applicable playbooks section>",
      "trigger_reason": "<string>"
    }
  ],
  "next_action": "<string: the single most important thing for the CSM to do in or after this meeting>"
}

Severity constraint: severity must be null if and only if description is null.

## Rules

1. Respond with valid JSON only. No prose before or after the JSON object.
2. All string fields must be non-empty unless explicitly marked nullable in the schema above.
3. themes must contain at least 1 entry and no more than 5.
4. talking_points must contain at least 1 entry and no more than 4.
5. risks may be an empty array [] if no material risks are identified.
6. playbooks may be an empty array [] if no applicable playbook is listed above.
7. evidence in each theme must reference a specific interaction from the Recent interactions section above by date or brief description. Do not reference events that do not appear in that section.
8. Do not include personally identifiable information beyond what is present in the input above.
9. playbooks[].name must exactly match a playbook name from the Applicable playbooks section above. If no playbook from that section applies, return playbooks: []. Do not invent playbook names.
10. Any stakeholder name used in any field (themes, talking_points, risks) must exactly match a name from the Stakeholders section above. If a relevant person appears in an interaction but is not a listed stakeholder, refer to them by their role (e.g., "the technical lead on the April 12 thread") rather than inventing a name.

## Language discipline

Write in the register of a senior CSM jotting a quick note before walking into a meeting: short sentences, specific observations, no padding, no throat-clearing. The register stays constant regardless of career_stage — what varies is how much explanation is included (see career_stage section above).

Use contractions freely. Avoid corporate buzzwords (leverage, synergy, circle back, etc.). Avoid phrases like "it's important to note" or "as mentioned above."
`.trim();
}


// ── Section formatters ────────────────────────────────────────────────────────

function formatInteractions(interactions) {
  if (!interactions?.length) return 'No recent interactions on record.';
  return interactions.map((i, idx) => {
    const date    = i.occurred_at ? new Date(i.occurred_at).toISOString().slice(0, 10) : 'unknown date';
    const source  = i.source ?? 'unknown';
    const content = (i.summary || i.content || '').slice(0, 600);
    return `[${idx + 1}] ${date} | ${source}\n${content}`;
  }).join('\n\n');
}

function formatStakeholders(stakeholders) {
  if (!stakeholders?.length) return 'No stakeholders on record.';
  return stakeholders.map(s =>
    `- ${s.name}${s.role ? ` (${s.role})` : ''}${s.email ? ` <${s.email}>` : ''}`
  ).join('\n');
}

function formatTasks(tasks) {
  if (!tasks?.length) return 'No open tasks.';
  return tasks.map(t => {
    const due = t.due_date ? ` — due ${t.due_date}` : '';
    return `- [${t.priority}] ${t.title}${due}`;
  }).join('\n');
}

function formatPlaybooks(playbooks) {
  if (!playbooks?.length) return 'None applicable.';
  return playbooks.map(p =>
    `- ${p.name}${p.description ? `: ${p.description}` : ''}`
  ).join('\n');
}

function formatWorkingStyle(ws) {
  if (!ws || !Object.keys(ws).length) return 'No preferences set.';
  const parts = [];
  if (ws.communication_preference) parts.push(`communication: ${ws.communication_preference}`);
  if (ws.meeting_length)           parts.push(`meeting length: ${ws.meeting_length}`);
  if (ws.risk_tolerance)           parts.push(`risk tolerance: ${ws.risk_tolerance}`);
  return parts.length ? parts.join(', ') : 'No preferences set.';
}


// ── CSM profile guidance ──────────────────────────────────────────────────────

function careerStageGuidance(stage) {
  switch (stage) {
    case 'junior':
      return 'Include brief rationale for every talking point and risk. Flag anything that might surprise a less-experienced CSM.';
    case 'mid':
      return 'Include rationale for non-obvious items only. Skip obvious inferences.';
    case 'senior':
      return 'Skip rationale unless the observation is genuinely surprising. Keep it tight.';
    case 'lead':
      return 'Ultra-terse. No rationale unless a risk is exceptional. Assume maximum pattern recognition.';
    default:
      return '';
  }
}

function specialtyGuidance(specialty) {
  switch (specialty) {
    case 'general_csm':
      return 'Balanced coverage across health, expansion signals, and risk. No single area dominates.';
    case 'technical_csm':
      return 'Emphasise integration issues, API behaviour, and technical debt observed in interaction history. Surface technical blockers before strategic ones.';
    case 'enterprise_csm':
      return 'Emphasise multi-stakeholder dynamics and executive sponsor signals. Flag any change in decision-maker access or influence.';
    case 'growth_csm':
      return 'Emphasise expansion signals, usage trends, and upsell readiness. Downweight pure health maintenance unless a churn signal is present.';
    default:
      return '';
  }
}


module.exports = { buildBriefPrompt, promptVersionHash, BRIEF_MODEL, BRIEF_PROMPT_VERSION };
