// engine/dataStateHash.js
//
// Deterministic SHA-256 hash over account context, used as one component of
// the 6-tuple brief cache key. A change to any included field produces a new
// hash, bypassing the cached brief and triggering regeneration.
//
// Field selection rationale:
//   account.{health_score, churn_risk, nps, ces, stage, renewal_date}
//     — These columns directly appear in the brief prompt. Any change here
//       meaningfully alters the output.
//   account.updated_at
//     — Acts as a catch-all for every other account column (name, notes, etc.).
//       Any write to the accounts row moves updated_at, dragging the hash
//       forward without enumerating every column.
//   interactions[].{id, updated_at}
//     — The set of interaction IDs captures additions/deletions; updated_at
//       captures edits. Content/summary are not hashed directly because
//       updated_at already moves on any content change.
//   stakeholders[].{id, updated_at}  — same reasoning as interactions
//   tasks[].{id, updated_at}         — same reasoning
//   playbooks[].{id}
//     — Playbook *content* is versioned via prompt_version_hash (the prompt
//       template embeds the playbook text). We only need to know which
//       playbooks are applicable; prompt_version_hash handles content drift.
//   csm_profile.{updated_at}
//     — career_stage, specialty, and working_style all move updated_at on
//       write (app-managed, per migration M2b convention). One timestamp
//       captures all three fields.

const crypto = require('crypto');

// Recursively sort object keys so JSON.stringify output is deterministic
// regardless of insertion order. Arrays are left in the caller-imposed order
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

function dataStateHash({ account, interactions, stakeholders, tasks, playbooks, csmProfile }) {
  const canonical = {
    account: {
      ces:          account.ces          ?? null,
      churn_risk:   account.churn_risk   ?? null,
      health_score: account.health_score ?? null,
      nps:          account.nps          ?? null,
      renewal_date: account.renewal_date ?? null,
      stage:        account.stage        ?? null,
      updated_at:   account.updated_at   ?? null,
    },
    csm_profile: csmProfile
      ? { updated_at: csmProfile.updated_at ?? null }
      : null,
    interactions: (interactions || [])
      .map(i => ({ id: i.id, updated_at: i.updated_at ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    playbooks: (playbooks || [])
      .map(p => ({ id: p.id }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    stakeholders: (stakeholders || [])
      .map(s => ({ id: s.id, updated_at: s.updated_at ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    tasks: (tasks || [])
      .map(t => ({ id: t.id, updated_at: t.updated_at ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sortKeys(canonical)))
    .digest('hex');
}

module.exports = { dataStateHash };
