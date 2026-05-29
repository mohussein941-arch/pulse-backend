// engine/closeoutValidator.js
//
// Validates the JSON output of the post-meeting closeout Claude call.
// Hand-rolled to mirror briefValidator.js — no third-party schema library.

class CloseoutValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloseoutValidationError';
  }
}

const VALID_SENTIMENTS = new Set(['positive', 'neutral', 'at_risk']);
const VALID_DIRECTIONS = new Set(['positive', 'neutral', 'negative']);
const VALID_MAGNITUDES = new Set(['minor', 'moderate', 'significant']);
const VALID_OWNERS     = new Set(['customer', 'us']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);

const TOP_LEVEL_KEYS = new Set([
  'summary', 'sentiment', 'health_signal', 'action_items',
  'suggested_tasks', 'follow_up_email', 'crm_update_text',
]);

function validateCloseoutOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CloseoutValidationError('Output is not a JSON object');
  }

  // additionalProperties: false at top level
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new CloseoutValidationError(`Unexpected top-level property: "${key}"`);
    }
  }

  // summary
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new CloseoutValidationError('summary must be a non-empty string');
  }

  // sentiment
  if (!VALID_SENTIMENTS.has(parsed.sentiment)) {
    throw new CloseoutValidationError(
      `sentiment must be "positive", "neutral", or "at_risk"; got "${parsed.sentiment}"`
    );
  }

  // health_signal
  const hs = parsed.health_signal;
  if (!hs || typeof hs !== 'object' || Array.isArray(hs)) {
    throw new CloseoutValidationError('health_signal must be an object');
  }
  if (!VALID_DIRECTIONS.has(hs.direction)) {
    throw new CloseoutValidationError(
      `health_signal.direction must be "positive", "neutral", or "negative"; got "${hs.direction}"`
    );
  }
  if (!VALID_MAGNITUDES.has(hs.magnitude)) {
    throw new CloseoutValidationError(
      `health_signal.magnitude must be "minor", "moderate", or "significant"; got "${hs.magnitude}"`
    );
  }
  if (typeof hs.rationale !== 'string' || !hs.rationale.trim()) {
    throw new CloseoutValidationError('health_signal.rationale must be a non-empty string');
  }

  // action_items
  if (!Array.isArray(parsed.action_items)) {
    throw new CloseoutValidationError('action_items must be an array');
  }
  for (let i = 0; i < parsed.action_items.length; i++) {
    const ai = parsed.action_items[i];
    if (typeof ai.description !== 'string' || !ai.description.trim()) {
      throw new CloseoutValidationError(`action_items[${i}].description must be a non-empty string`);
    }
    if (!VALID_OWNERS.has(ai.owner)) {
      throw new CloseoutValidationError(
        `action_items[${i}].owner must be "customer" or "us"; got "${ai.owner}"`
      );
    }
  }

  // suggested_tasks
  if (!Array.isArray(parsed.suggested_tasks)) {
    throw new CloseoutValidationError('suggested_tasks must be an array');
  }
  for (let i = 0; i < parsed.suggested_tasks.length; i++) {
    const st = parsed.suggested_tasks[i];
    if (typeof st.title !== 'string' || !st.title.trim()) {
      throw new CloseoutValidationError(`suggested_tasks[${i}].title must be a non-empty string`);
    }
    if (typeof st.description !== 'string' || !st.description.trim()) {
      throw new CloseoutValidationError(`suggested_tasks[${i}].description must be a non-empty string`);
    }
    if (!VALID_PRIORITIES.has(st.priority)) {
      throw new CloseoutValidationError(
        `suggested_tasks[${i}].priority must be "low", "medium", or "high"; got "${st.priority}"`
      );
    }
    if (!Number.isInteger(st.due_in_days) || st.due_in_days < 0) {
      throw new CloseoutValidationError(
        `suggested_tasks[${i}].due_in_days must be a non-negative integer; got ${st.due_in_days}`
      );
    }
  }

  // follow_up_email
  const fe = parsed.follow_up_email;
  if (!fe || typeof fe !== 'object' || Array.isArray(fe)) {
    throw new CloseoutValidationError('follow_up_email must be an object');
  }
  if (typeof fe.subject !== 'string' || !fe.subject.trim()) {
    throw new CloseoutValidationError('follow_up_email.subject must be a non-empty string');
  }
  if (typeof fe.body !== 'string' || !fe.body.trim()) {
    throw new CloseoutValidationError('follow_up_email.body must be a non-empty string');
  }

  // crm_update_text
  if (typeof parsed.crm_update_text !== 'string' || !parsed.crm_update_text.trim()) {
    throw new CloseoutValidationError('crm_update_text must be a non-empty string');
  }

  return parsed;
}

module.exports = { validateCloseoutOutput, CloseoutValidationError };
