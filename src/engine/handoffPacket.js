const defaultSupabase = require('../supabase');
const { synthesizeHealth } = require('./healthSynthesis');
const { recommendPlaybook } = require('./playbookRecommender');
const { generateCatchUp } = require('./catchUp');

// M7.2 — handoff packet: a structured ownership-transfer doc. Read-only.
// Assembles brain pieces (synthesis, recommendation, catch-up recap) + the
// structured facts a new owner needs. Each brain piece is independently non-fatal.
async function generateHandoffPacket({ orgId, accountId, userId, db = defaultSupabase }) {
  const { data: account } = await db
    .from('accounts')
    .select('id, name, stage, arr, plan, renewal_date, health_score, churn_risk, nps, last_contact, active_playbook_id')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!account) return null;

  const synthesis      = await synthesizeHealth({ orgId, accountId, db }).catch(() => null);
  const recommendation = await recommendPlaybook({ orgId, accountId, db }).catch(() => null);
  const recap          = await generateCatchUp({ orgId, accountId, userId, db }).catch(() => null);

  const { data: stakeholders } = await db
    .from('stakeholders')
    .select('name, title, role, email, sentiment')
    .eq('account_id', accountId)
    .eq('org_id', orgId);

  const { data: openTasks } = await db
    .from('tasks')
    .select('title, priority, due_date')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .eq('done', false)
    .order('due_date', { ascending: true });

  let activePlaybook = null;
  if (account.active_playbook_id) {
    const { data: pb } = await db
      .from('playbooks')
      .select('id, name, scenario')
      .eq('id', account.active_playbook_id)
      .maybeSingle();
    activePlaybook = pb || { id: account.active_playbook_id };
  }

  return {
    account: {
      id: account.id, name: account.name, stage: account.stage,
      arr: account.arr, plan: account.plan, renewal_date: account.renewal_date,
      health_score: account.health_score, churn_risk: account.churn_risk, nps: account.nps,
      last_contact: account.last_contact,
      trend: synthesis?.trend ?? null,
      momentum: synthesis?.momentum ?? null,
    },
    stakeholders:         stakeholders || [],
    open_tasks:           openTasks || [],
    active_playbook:      activePlaybook,
    recommended_playbook: recommendation,
    recap:                recap ? { narrative: recap.narrative, citation_ids: recap.citation_ids, citations: recap.citations } : null,
    generated_at:         new Date().toISOString(),
    generated_by:         userId,
  };
}

module.exports = { generateHandoffPacket };
