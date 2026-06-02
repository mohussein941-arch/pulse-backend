const defaultSupabase = require('../supabase');
const { synthesizeHealth } = require('./healthSynthesis');
const { getContext } = require('../services/context-engine/retrieval');
const { reason } = require('../services/context-engine/reasoning');

// M7.1 — "Catch me up on Acme": on-demand narrative recap of everything the
// brain knows about an account. Internal-facing, so citations are kept.
// Orchestrates: synthesizeHealth (current-state anchor) + getContext + reason.
async function generateCatchUp({ orgId, accountId, userId, db = defaultSupabase }) {
  const synthesis = await synthesizeHealth({ orgId, accountId, db });
  if (!synthesis) return null;

  const ctx = await getContext(
    `Full relationship history for ${synthesis.name}: meetings, emails, calls, decisions, commitments, issues, blockers, and recent activity`,
    { orgId, accountId, limit: 20, createdBy: userId }
  );

  const task =
    `Catch the CSM up on this account so they can walk into any conversation prepared. ` +
    `Current state: health ${synthesis.score ?? 'unknown'}/100, stage ${synthesis.stage ?? 'unknown'}, trend ${synthesis.trend}. ` +
    `Cover, as a clear narrative: who they are and the relationship arc, what has happened recently, ` +
    `any open threads or commitments, and the current risks or opportunities. ` +
    `Keep it tight — one or two short paragraphs — and cite the interactions you draw from.`;

  const result = await reason(ctx, task, {
    orgId, feature: 'catch_up', accountId, createdBy: userId, maxTokens: 700,
  });

  return {
    narrative:    result.output,
    citation_ids: result.citationIds,
    trace_id:     result.traceId,
    synthesis,
  };
}

module.exports = { generateCatchUp };
