// engine/automationRunner.js
// Evaluates automation rules against every account once per cron tick.
// Deduplication: a (rule, account) pair fires at most once every 24 hours.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Trigger evaluators ───────────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function triggered(rule, account) {
  const cfg = rule.trigger_config || {};
  switch (rule.trigger_type) {
    case 'health_below':
      return account.health_score != null && account.health_score < (cfg.threshold ?? 50);
    case 'no_contact_days':
      return daysSince(account.last_contact) >= (cfg.days ?? 14);
    case 'renewal_days': {
      const d = daysUntil(account.renewal_date);
      return d >= 0 && d <= (cfg.days ?? 30);
    }
    case 'nps_below':
      return account.nps != null && account.nps < (cfg.threshold ?? 50);
    case 'ces_below':
      return account.ces != null && account.ces < (cfg.threshold ?? 3);
    case 'usage_below':
      return account.product_usage != null && account.product_usage < (cfg.threshold ?? 40);
    default:
      return false;
  }
}

// ─── Action executors ─────────────────────────────────────────────────────────

function resolveText(template, account) {
  return template
    .replace('{account}', account.name)
    .replace('{health}', account.health_score ?? '?')
    .replace('{nps}', account.nps ?? '?')
    .replace('{ces}', account.ces ?? '?')
    .replace('{usage}', account.product_usage ?? '?');
}

async function executeAction(rule, account) {
  const cfg  = rule.action_config || {};
  const today = new Date().toISOString().split('T')[0];

  if (rule.action_type === 'log_activity') {
    const note = resolveText(cfg.note || `Automation: ${rule.name}`, account);
    await supabase.from('activity_log').insert({
      user_id:    rule.user_id,
      account_id: account.id,
      type:       'Note',
      note,
      logged_at:  today,
    });
    return note;
  }

  if (rule.action_type === 'create_task') {
    const title = resolveText(cfg.title || `Follow up: ${account.name}`, account);
    await supabase.from('activity_log').insert({
      user_id:    rule.user_id,
      account_id: account.id,
      type:       'Task',
      note:       title,
      logged_at:  today,
    });
    return title;
  }

  return null;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

async function firedRecently(ruleId, accountId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('automation_log')
    .select('id')
    .eq('rule_id', ruleId)
    .eq('account_id', accountId)
    .gte('fired_at', since)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runAutomationEngine() {
  try {
    const { data: rules } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('enabled', true);

    if (!rules?.length) return;

    // Group rules by user so we fetch accounts once per user
    const byUser = {};
    for (const rule of rules) {
      (byUser[rule.user_id] = byUser[rule.user_id] || []).push(rule);
    }

    for (const [userId, userRules] of Object.entries(byUser)) {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, name, health_score, nps, ces, product_usage, last_contact, renewal_date, archived')
        .eq('user_id', userId)
        .eq('archived', false);

      if (!accounts?.length) continue;

      for (const rule of userRules) {
        for (const account of accounts) {
          if (!triggered(rule, account)) continue;
          if (await firedRecently(rule.id, account.id)) continue;

          const detail = await executeAction(rule, account);

          await supabase.from('automation_log').insert({
            user_id:      userId,
            rule_id:      rule.id,
            account_id:   account.id,
            account_name: account.name,
            rule_name:    rule.name,
            action_type:  rule.action_type,
            detail,
          });
        }
      }
    }

    console.log(`[automation] tick complete — ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[automation] runner error:', err.message);
  }
}

module.exports = { runAutomationEngine };
