const defaultSupabase = require('../supabase');
const { synthesizeHealth } = require('./healthSynthesis');
const { getContext } = require('../services/context-engine/retrieval');
const { reason } = require('../services/context-engine/reasoning');

// M4.2 — explains an account's health in cited plain language.
// Orchestrates: synthesizeHealth (numbers/trend) + getContext (history) + reason (prose).
async function generateHealthNarrative({ orgId, accountId, userId, db = defaultSupabase }) {
  const synthesis = await synthesizeHealth({ orgId, accountId, db });
  if (!synthesis) return null;

  const ctx = await getContext(
    `Health, risks, sentiment, satisfaction, blockers, and renewal signals for ${synthesis.name}`,
    { orgId, accountId, limit: 12, createdBy: userId }
  );

  const task =
    `Explain this customer account's health for its CSM. ` +
    `Current health score: ${synthesis.score ?? 'unknown'} / 100 (stage: ${synthesis.stage ?? 'unknown'}, churn risk: ${synthesis.churn_risk ?? 'unknown'}%). ` +
    `Trend: ${synthesis.trend}. Recent signal momentum: ${synthesis.momentum.label} (${synthesis.momentum.signal_count} signals). ` +
    `Write 2-4 sentences in plain language: why the health is where it is, what's driving the trend, and where it's heading. ` +
    `Ground every claim in the retrieved interactions and cite them.`;

  const result = await reason(ctx, task, {
    orgId, feature: 'health_narrative', accountId, createdBy: userId, maxTokens: 400,
  });

  return {
    narrative:    result.output,
    citation_ids: result.citationIds,
    trace_id:     result.traceId,
    synthesis,
  };
}

module.exports = { generateHealthNarrative };
