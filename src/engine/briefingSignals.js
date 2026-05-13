// engine/briefingSignals.js
// Scans accounts + tasks for a user and returns scored signal items.

const TODAY_OFFSET = 0; // set to non-zero in tests to simulate a different date

function todayStr() {
  const d = new Date();
  d.setDate(d.getDate() + TODAY_OFFSET);
  return d.toISOString().split('T')[0];
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date(todayStr())) / 86_400_000);
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(todayStr()) - new Date(dateStr)) / 86_400_000);
}

// ── Escalation tiers ──────────────────────────────────────────────────────────
// base ≥7 → high tier   (+1.5/day, cap +12)
// base 5-6 → medium     (+0.8/day, cap +5)
// base ≤4 → low         (+0.4/day, cap +3)
function escalationBonus(baseScore, carryDays) {
  if (baseScore >= 7) return Math.min(carryDays * 1.5, 12);
  if (baseScore >= 5) return Math.min(carryDays * 0.8, 5);
  return Math.min(carryDays * 0.4, 3);
}

function currentScore(baseScore, carryDays) {
  return baseScore + escalationBonus(baseScore, carryDays);
}

const THRESHOLD = 6;

// ── Scan accounts for action signals ─────────────────────────────────────────
function scanAccountSignals(accounts) {
  const signals = [];

  for (const a of accounts) {
    const rdays = a.renewal_date ? daysBetween(a.renewal_date) : null;
    const contactDays = a.last_contact ? daysSince(a.last_contact) : null;

    // Renewal critical (≤14 days)
    if (rdays !== null && rdays >= 0 && rdays <= 14) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'renewal_critical',
        signalDetail: `Renewal in ${rdays} day${rdays === 1 ? '' : 's'}`, baseScore: 9 });
    }
    // Renewal warning (15-30 days)
    else if (rdays !== null && rdays >= 0 && rdays <= 30) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'renewal_warning',
        signalDetail: `Renewal in ${rdays} days`, baseScore: 6 });
    }

    // Churn risk critical (≥70%)
    if ((a.churn_risk || 0) >= 70) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'churn_risk_critical',
        signalDetail: `Churn risk at ${a.churn_risk}%`, baseScore: 8 });
    }

    // Health critical (<40)
    if ((a.health_score || 100) < 40) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'health_critical',
        signalDetail: `Health score at ${a.health_score}/100`, baseScore: 8 });
    }
    // Health warning (40-55)
    else if ((a.health_score || 100) < 55) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'health_warning',
        signalDetail: `Health score at ${a.health_score}/100`, baseScore: 5 });
    }

    // No contact critical (>30 days)
    if (contactDays !== null && contactDays > 30) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'no_contact_critical',
        signalDetail: `No contact in ${contactDays} days`, baseScore: 6 });
    }
    // No contact warning (15-30 days)
    else if (contactDays !== null && contactDays > 14) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'no_contact_warning',
        signalDetail: `No contact in ${contactDays} days`, baseScore: 4 });
    }

    // Low NPS (<30)
    if ((a.nps || 50) < 30) {
      signals.push({ accountId: a.id, accountName: a.name, signalType: 'low_nps',
        signalDetail: `NPS at ${a.nps}`, baseScore: 6 });
    }
  }

  return signals;
}

// ── Scan tasks for overdue + due-today ────────────────────────────────────────
function scanTaskSignals(tasks) {
  const today = todayStr();
  const signals = [];

  for (const t of tasks) {
    if (t.done) continue;
    if (!t.due_date) continue;

    if (t.due_date < today) {
      const daysOverdue = daysSince(t.due_date);
      signals.push({
        accountId:    t.account_id || null,
        accountName:  null,
        taskId:       t.id,
        signalType:   'task_overdue',
        signalDetail: `${t.title} — overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`,
        baseScore:    4,
        category:     'task',
      });
    } else if (t.due_date === today) {
      signals.push({
        accountId:    t.account_id || null,
        accountName:  null,
        taskId:       t.id,
        signalType:   'task_due_today',
        signalDetail: t.title,
        baseScore:    3,
        category:     'task',
      });
    }
  }

  return signals;
}

// ── Scan for wins (last 24h) ──────────────────────────────────────────────────
function scanWins(accounts, recentSurveyResponses) {
  const wins = [];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  for (const a of accounts) {
    // Recent activity logged today
    const recentActivity = (a.activity_log || []).filter(l => {
      const d = new Date(l.logged_at || l.date || '');
      return d >= yesterday;
    });
    for (const act of recentActivity) {
      wins.push({ accountId: a.id, accountName: a.name, signalType: 'activity_logged',
        signalDetail: `${act.type} logged with ${a.name}`, baseScore: 0, category: 'win' });
    }

    // Completed milestones recently
    const doneMilestones = (a.milestones || []).filter(m => m.done);
    if (doneMilestones.length > 0) {
      wins.push({ accountId: a.id, accountName: a.name, signalType: 'milestone_completed',
        signalDetail: `${doneMilestones.length} milestone${doneMilestones.length > 1 ? 's' : ''} completed`,
        baseScore: 0, category: 'win' });
    }
  }

  // Positive survey responses
  for (const r of (recentSurveyResponses || [])) {
    const isPositive = (r.type === 'NPS' && r.score >= 70) ||
                       (r.type === 'CES' && r.score >= 4)  ||
                       (r.type === 'CSAT' && r.score >= 4);
    if (isPositive) {
      wins.push({ accountId: r.account_id, accountName: r.account_name,
        signalType: 'survey_positive',
        signalDetail: `${r.type} score of ${r.score} received from ${r.account_name}`,
        baseScore: 0, category: 'win' });
    }
  }

  return wins;
}

module.exports = {
  scanAccountSignals,
  scanTaskSignals,
  scanWins,
  currentScore,
  escalationBonus,
  THRESHOLD,
  todayStr,
};
