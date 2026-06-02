const defaultSupabase = require('../supabase');

const MAGNITUDE_WEIGHT = { minor: 1, moderate: 2, significant: 3 };
const DIRECTION_SIGN   = { positive: 1, neutral: 0, negative: -1 };
const WINDOW_DAYS = 90;

// Augments calcHealth (the quantitative score, unchanged) with the qualitative
// health_signal trend the score ignores. Read-only; computes on demand.
async function synthesizeHealth({ orgId, accountId, db = defaultSupabase }) {
  const { data: account } = await db
    .from('accounts')
    .select('id, name, health_score, churn_risk, stage')
    .eq('id', accountId).eq('org_id', orgId).maybeSingle();
  if (!account) return null;

  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

  const { data: signals } = await db
    .from('interactions')
    .select('content, metadata, occurred_at')
    .eq('account_id', accountId).eq('org_id', orgId)
    .eq('source', 'health_signal')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false });

  let net = 0;
  const recentSignals = (signals || []).map(s => {
    const dir = s.metadata?.health_signal_direction ?? 'neutral';
    const mag = s.metadata?.health_signal_magnitude ?? 'minor';
    net += (DIRECTION_SIGN[dir] ?? 0) * (MAGNITUDE_WEIGHT[mag] ?? 1);
    return { direction: dir, magnitude: mag, rationale: s.content, occurred_at: s.occurred_at };
  });
  const momentumLabel = net > 0 ? 'positive' : net < 0 ? 'negative' : 'flat';

  const { data: history } = await db
    .from('health_history')
    .select('score, recorded_at')
    .eq('account_id', accountId).eq('org_id', orgId)
    .gte('recorded_at', since.slice(0, 10))
    .order('recorded_at', { ascending: true });

  let historyTrend = null;
  if (history && history.length >= 2) {
    const delta = history[history.length - 1].score - history[0].score;
    historyTrend = delta > 3 ? 'improving' : delta < -3 ? 'declining' : 'stable';
  }

  let trend;
  if (recentSignals.length > 0) {
    trend = momentumLabel === 'positive' ? 'improving'
          : momentumLabel === 'negative' ? 'declining'
          : (historyTrend || 'stable');
  } else if (historyTrend) {
    trend = historyTrend;
  } else {
    trend = 'insufficient_data';
  }

  return {
    account_id: account.id,
    name:       account.name,
    score:      account.health_score,
    churn_risk: account.churn_risk,
    stage:      account.stage,
    trend,
    momentum:   { net, label: momentumLabel, signal_count: recentSignals.length },
    score_history:  (history || []).map(h => ({ score: h.score, recorded_at: h.recorded_at })),
    recent_signals: recentSignals.slice(0, 5),
  };
}

module.exports = { synthesizeHealth };
