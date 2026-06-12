// src/engine/closeoutPrompt.js
// Builds the post-meeting closeout prompt sent to Claude for synthesis.
// Bump CLOSEOUT_PROMPT_VERSION whenever any static prompt text changes —
// the version is hashed into the cache key so stale cached closeouts are
// automatically bypassed after a prompt update.

const crypto = require('crypto');

const CLOSEOUT_PROMPT_VERSION = 'v2';
const CLOSEOUT_MODEL = 'claude-sonnet-4-6';

function promptVersionHash() {
  return crypto.createHash('sha256').update(CLOSEOUT_PROMPT_VERSION).digest('hex');
}

function buildCloseoutPrompt({ contextText, transcript, playbooks, csmProfile }) {
  const {
    career_stage  = 'mid',
    specialty     = 'general_csm',
    working_style = {},
  } = csmProfile || {};

  return `
You are a senior Customer Success intelligence assistant. Analyse the meeting transcript below and generate a structured post-meeting closeout for the CSM who just completed this call.

## Meeting transcript

${formatTranscript(transcript)}

## Account context

${contextText}

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
  "summary": "<string: 2–4 sentences on what happened in this meeting and the current account state>",
  "sentiment": "positive" | "neutral" | "at_risk",
  "health_signal": {
    "direction": "positive" | "neutral" | "negative",
    "magnitude": "minor" | "moderate" | "significant",
    "rationale": "<string: specific evidence from the transcript>"
  },
  "action_items": [
    {
      "description": "<string: verbatim or close paraphrase of the commitment made>",
      "owner": "customer" | "us"
    }
  ],
  "suggested_tasks": [
    {
      "title": "<string>",
      "description": "<string>",
      "priority": "low" | "medium" | "high",
      "due_in_days": <non-negative integer>
    }
  ],
  "follow_up_email": {
    "subject": "<string: short and specific to this meeting>",
    "body": "<string: references specific content from the transcript>"
  },
  "crm_update_text": "<string: one short paragraph — what happened, what's next; no salutation>"
}

## Rules

1. Respond with valid JSON only. No markdown fences. No prose before or after the JSON object.
2. All required keys must be present. Arrays may be empty ([]) but the keys must be present.
3. action_items must reflect what was actually said in the transcript. Do not invent commitments. If nothing was committed, return action_items: [].
4. suggested_tasks must not duplicate any item already in the WORKSTREAMS section. Each suggested task must be a concrete CSM action, not a restatement of an action item.
5. follow_up_email body must reference specific things from the meeting transcript by content (not by paraphrase of action items only). Subject is short and specific.
6. crm_update_text is one short paragraph suitable for pasting into account notes — what happened and what's next; no salutation.
7. sentiment must be one of: "positive", "neutral", "at_risk". Use "at_risk" (not "negative") for the negative pole.
8. health_signal.direction must be one of: "positive", "neutral", "negative". Note: sentiment and health_signal.direction use different labels for their negative poles by design — do not normalise them.
9. health_signal.magnitude must be one of: "minor", "moderate", "significant".
10. action_items[].owner must be one of: "customer", "us".
11. suggested_tasks[].priority must be one of: "low", "medium", "high".
12. suggested_tasks[].due_in_days must be a non-negative integer.
13. Do not include personally identifiable information beyond what is present in the input above.

## Language discipline

Write in the register of a senior CSM jotting a quick note after walking out of a meeting: short sentences, specific observations, no padding, no throat-clearing. The register stays constant regardless of career_stage — what varies is how much explanation is included (see career_stage section above).

Use contractions freely. Avoid corporate buzzwords (leverage, synergy, circle back, etc.). Avoid phrases like "it's important to note" or "as mentioned above."
`.trim();
}


// ── Section formatters ────────────────────────────────────────────────────────

function formatTranscript(transcript) {
  if (!transcript || !transcript.trim()) return 'No transcript provided.';
  return transcript.trim();
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


module.exports = { buildCloseoutPrompt, promptVersionHash, CLOSEOUT_MODEL, CLOSEOUT_PROMPT_VERSION };
