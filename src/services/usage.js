const supabase = require("../supabase");

function calculateUsageScore(m) {
  const scores = [];

  // Capacity-relative ratios — only when the declared denominator is present.
  if (m.active_users != null && m.licensed_seats > 0) {
    scores.push({ score: Math.min(100, (m.active_users / m.licensed_seats) * 100), weight: 2 });
  }
  if (m.dau != null && m.mau > 0) {
    scores.push({ score: Math.min(100, (m.dau / m.mau) * 100), weight: 2 });
  }
  if (m.features_used_count != null && m.total_features > 0) {
    scores.push({ score: Math.min(100, (m.features_used_count / m.total_features) * 100), weight: 1 });
  }

  // Engagement signals derived from events alone — no declared capacity required.
  if (m.days_since_active != null) {
    const d = m.days_since_active;
    const recency =
      d <= 1  ? 100 :
      d <= 7  ? 80  :
      d <= 14 ? 60  :
      d <= 30 ? 40  :
      d <= 60 ? 20  : 0;
    scores.push({ score: recency, weight: 3 });
  }
  if (m.events_count != null && m.events_count_prev != null) {
    const curr = m.events_count, prev = m.events_count_prev;
    let trend = null;
    if (prev === 0 && curr === 0)    trend = null;                       // no activity either window
    else if (prev === 0 && curr > 0) trend = 100;                        // brand-new / reactivated
    else if (curr === 0 && prev > 0) trend = 0;                          // went silent
    else                             trend = Math.min(100, (curr / prev) * 50); // flat=50, doubled=100
    if (trend != null) scores.push({ score: trend, weight: 2 });
  }

  if (scores.length === 0) {
    if (m.product_usage != null) return Math.min(100, Math.max(0, parseFloat(m.product_usage)));
    return null;
  }

  const totalWeight = scores.reduce((a, b) => a + b.weight, 0);
  return Math.round(scores.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight);
}

async function computeUsageMetrics(account, asOf = new Date()) {
  const { data, error } = await supabase.rpc("compute_usage_metrics", {
    p_account_id: account.id,
    p_org_id:     account.org_id,
    p_as_of:      asOf.toISOString(),
  });
  if (error) throw error;
  const r = (data && data[0]) || {};
  const daysSince = r.last_active_at
    ? Math.floor((asOf.getTime() - new Date(r.last_active_at).getTime()) / 86400000)
    : null;
  return {
    dau: r.dau ?? 0, wau: r.wau ?? 0, mau: r.mau ?? 0, active_users: r.active_users ?? 0,
    last_active_at: r.last_active_at ?? null, days_since_active: daysSince,
    events_count: r.events_count ?? 0, events_count_prev: r.events_count_prev ?? 0,
    features_used_count: r.features_used_count ?? 0, sessions_last_30d: r.sessions_last_30d ?? null,
    key_events: r.key_events ?? null,
    licensed_seats: account.licensed_seats ?? null,
    total_features: account.licensed_features ?? null,
    raw_payload: null,
  };
}

module.exports = { calculateUsageScore, computeUsageMetrics };
