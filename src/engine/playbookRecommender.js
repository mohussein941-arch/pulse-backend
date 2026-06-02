const defaultSupabase = require('../supabase');
const { synthesizeHealth } = require('./healthSynthesis');

const daysUntil = d => d ? Math.floor((new Date(d).getTime() - Date.now()) / 86400000) : Infinity;
const daysSince = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : Infinity;

// Decision tree → { id, reason } or null.
function selectPlaybook(account, trend) {
  const health = account.health_score ?? 100;
  const churn  = account.churn_risk ?? 0;
  const usage  = account.product_usage ?? 100;
  const rdays  = daysUntil(account.renewal_date);
  const cdays  = daysSince(account.last_contact);
  const age    = daysSince(account.created_at);
  const declining = trend === 'declining';

  if (rdays >= 0 && rdays <= 60) {
    if (health < 55 || declining)
      return { id: 'pb-008', reason: `Renewal in ${rdays} days with health ${declining ? 'declining' : 'below target'} — run the At-Risk Renewal play.` };
    if (health >= 75 && usage >= 70)
      return { id: 'pb-009', reason: `Renewal in ${rdays} days with strong health and usage — pursue the Expansion Signal play.` };
    return { id: 'pb-007', reason: `Renewal in ${rdays} days — prepare with the Renewal Preparation play.` };
  }
  if (health < 40 || churn >= 70)
    return { id: 'pb-005', reason: `Health critical${churn >= 70 ? ` and churn risk at ${churn}%` : ''} — run the Critical Recovery play.` };
  if (declining || (health >= 40 && health < 55))
    return { id: 'pb-004', reason: declining
      ? `Health is trending down before the score reflects it — run the Early Warning Response play.`
      : `Health is slipping (${health}/100) — run the Early Warning Response play.` };
  if (cdays > 30 && cdays !== Infinity)
    return { id: 'pb-006', reason: `No contact in ${cdays} days — run the Silent Account Re-engagement play.` };
  if (age <= 30)
    return { id: 'pb-001', reason: `New account (${age} days old) — run the New Account Activation play.` };
  if (age <= 60 && usage < 40)
    return { id: 'pb-002', reason: `Onboarding stalled (low usage at ${age} days) — run the Slow Onboarding Recovery play.` };
  return null;
}

async function recommendPlaybook({ orgId, accountId, db = defaultSupabase }) {
  const { data: account } = await db
    .from('accounts')
    .select('id, name, org_id, health_score, churn_risk, product_usage, renewal_date, last_contact, created_at, active_playbook_id')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (!account) return null;
  if (account.active_playbook_id) return null;

  let trend = null;
  try {
    const synthesis = await synthesizeHealth({ orgId, accountId, db });
    trend = synthesis?.trend ?? null;
  } catch (_) { /* trend optional */ }

  const choice = selectPlaybook(account, trend);
  if (!choice) return null;

  const { data: playbook } = await db
    .from('playbooks')
    .select('id, name, scenario, priority')
    .eq('id', choice.id)
    .eq('active', true)
    .maybeSingle();

  if (!playbook) return null;

  return { account_id: accountId, playbook_id: playbook.id, name: playbook.name,
           scenario: playbook.scenario, priority: playbook.priority, reason: choice.reason, trend };
}

module.exports = { recommendPlaybook };
