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

module.exports = { calculateUsageScore };
