// engine/briefValidator.js
//
// Validates the JSON output of the pre-meeting brief Claude call against the
// v4 schema and the fabrication-prevention rules from briefPrompt.js.
//
// Rule 10 heuristic — stakeholder name validation scope:
//   Only risks[].owner is validated against stakeholderNames. That field is
//   explicitly typed in the schema as "exact stakeholder name or null", making
//   every non-null value a deliberate name-match attempt by the model. The
//   free-text fields in themes (topic, evidence) and talking_points (point,
//   rationale) are prose — they legitimately reference people by role, partial
//   name, or description, so scanning them for name violations generates false
//   positives and would trigger unnecessary retries that degrade brief quality.
//   If stricter Rule 10 enforcement on prose fields becomes a requirement,
//   use a named-entity recogniser rather than substring matching.

class BriefValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefValidationError';
  }
}

const VALID_SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const VALID_SEVERITIES = new Set(['high', 'medium', 'low']);

function validateBriefOutput(parsed, { stakeholderNames = [], playbookNames = [] } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BriefValidationError('Output is not a JSON object');
  }

  // summary
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new BriefValidationError('summary must be a non-empty string');
  }

  // themes — [1, 5] entries
  if (!Array.isArray(parsed.themes)) {
    throw new BriefValidationError('themes must be an array');
  }
  if (parsed.themes.length < 1 || parsed.themes.length > 5) {
    throw new BriefValidationError(
      `themes must have 1–5 entries; got ${parsed.themes.length}`
    );
  }
  for (let i = 0; i < parsed.themes.length; i++) {
    const t = parsed.themes[i];
    if (typeof t.topic !== 'string' || !t.topic.trim()) {
      throw new BriefValidationError(`themes[${i}].topic must be a non-empty string`);
    }
    if (!VALID_SENTIMENTS.has(t.sentiment)) {
      throw new BriefValidationError(
        `themes[${i}].sentiment must be "positive", "neutral", or "negative"; got "${t.sentiment}"`
      );
    }
    if (typeof t.evidence !== 'string' || !t.evidence.trim()) {
      throw new BriefValidationError(`themes[${i}].evidence must be a non-empty string`);
    }
  }

  // talking_points — [1, 4] entries
  if (!Array.isArray(parsed.talking_points)) {
    throw new BriefValidationError('talking_points must be an array');
  }
  if (parsed.talking_points.length < 1 || parsed.talking_points.length > 4) {
    throw new BriefValidationError(
      `talking_points must have 1–4 entries; got ${parsed.talking_points.length}`
    );
  }
  for (let i = 0; i < parsed.talking_points.length; i++) {
    const tp = parsed.talking_points[i];
    if (typeof tp.point !== 'string' || !tp.point.trim()) {
      throw new BriefValidationError(`talking_points[${i}].point must be a non-empty string`);
    }
    if (typeof tp.rationale !== 'string' || !tp.rationale.trim()) {
      throw new BriefValidationError(`talking_points[${i}].rationale must be a non-empty string`);
    }
  }

  // risks
  if (!Array.isArray(parsed.risks)) {
    throw new BriefValidationError('risks must be an array');
  }
  const ownerSet = stakeholderNames.length > 0
    ? new Set(stakeholderNames.map(n => n.toLowerCase()))
    : null;

  for (let i = 0; i < parsed.risks.length; i++) {
    const r = parsed.risks[i];

    const descPresent = r.description !== null && r.description !== undefined;
    const sevPresent  = r.severity   !== null && r.severity   !== undefined;

    if (descPresent && !sevPresent) {
      throw new BriefValidationError(
        `risks[${i}]: severity must not be null when description is set`
      );
    }
    if (!descPresent && sevPresent) {
      throw new BriefValidationError(
        `risks[${i}]: severity must be null when description is null`
      );
    }
    if (sevPresent && !VALID_SEVERITIES.has(r.severity)) {
      throw new BriefValidationError(
        `risks[${i}].severity must be "high", "medium", or "low"; got "${r.severity}"`
      );
    }

    // Rule 10: risks[].owner is a structured stakeholder-name field — validate directly
    if (r.owner !== null && r.owner !== undefined) {
      if (typeof r.owner !== 'string' || !r.owner.trim()) {
        throw new BriefValidationError(`risks[${i}].owner must be a non-empty string or null`);
      }
      if (ownerSet && !ownerSet.has(r.owner.toLowerCase())) {
        throw new BriefValidationError(
          `risks[${i}].owner "${r.owner}" does not match any stakeholder name`
        );
      }
    }
  }

  // playbooks — Rule 9: name must exactly match an applicable playbook
  if (!Array.isArray(parsed.playbooks)) {
    throw new BriefValidationError('playbooks must be an array');
  }
  const playbookSet = playbookNames.length > 0 ? new Set(playbookNames) : null;
  for (let i = 0; i < parsed.playbooks.length; i++) {
    const pb = parsed.playbooks[i];
    if (typeof pb.name !== 'string' || !pb.name.trim()) {
      throw new BriefValidationError(`playbooks[${i}].name must be a non-empty string`);
    }
    if (playbookSet && !playbookSet.has(pb.name)) {
      throw new BriefValidationError(
        `playbooks[${i}].name "${pb.name}" does not match any applicable playbook name`
      );
    }
    if (typeof pb.trigger_reason !== 'string' || !pb.trigger_reason.trim()) {
      throw new BriefValidationError(
        `playbooks[${i}].trigger_reason must be a non-empty string`
      );
    }
  }

  // next_action
  if (typeof parsed.next_action !== 'string' || !parsed.next_action.trim()) {
    throw new BriefValidationError('next_action must be a non-empty string');
  }

  return parsed;
}

module.exports = { validateBriefOutput, BriefValidationError };
