// engine/dataStateHash.js
//
// Deterministic SHA-256 hash over the brief's prompt inputs.
//
// Rule: the hash covers the rendered account context (detContext.text from
// buildAccountContext) plus every non-assembler prompt input. Two invariants:
//   (1) New assembler sections self-invalidate — they change detContext.text,
//       which changes this hash, which busts the 24-hour cache automatically.
//   (2) New non-assembler inputs added to buildBriefPrompt (e.g. a new discrete
//       field passed alongside contextText, playbooks, or csmProfile) MUST be
//       added to the canonical object here. Omitting them means a prompt change
//       that doesn't touch assembler output would silently reuse a stale brief.

const crypto = require('crypto');

// Recursively sort object keys so JSON.stringify output is deterministic
// regardless of insertion order. Arrays are left in caller-imposed order
// (callers sort arrays by id before passing them here).
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
  }
  return value;
}

function dataStateHash({ contextText, csmProfile, playbooks }) {
  const cp = csmProfile || {};
  const canonical = {
    contextText: contextText ?? '',
    csmProfile: {
      career_stage:  cp.career_stage  ?? null,
      specialty:     cp.specialty     ?? null,
      working_style: cp.working_style ?? null,
    },
    playbookIds: (playbooks || [])
      .map(p => p.id)
      .sort((a, b) => String(a).localeCompare(String(b))),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sortKeys(canonical)))
    .digest('hex');
}

module.exports = { dataStateHash };
