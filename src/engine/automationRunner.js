// engine/automationRunner.js
// Evaluates automation rules against every account once per cron tick.
// Deduplication: each (rule, account) pair has a per-trigger-type cooldown.

const { createClient }       = require('@supabase/supabase-js');
const { sendAutomationEmail } = require('../utils/emailSender');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Cooldown per trigger type ────────────────────────────────────────────────
// account_age_days fires once at the milestone age — 30-day cooldown prevents re-firing
const COOLDOWN_HOURS = {
  account_age_days: 720,
};
function cooldownHours(triggerType) {
  return COOLDOWN_HOURS[triggerType] ?? 24;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

// ─── Trigger evaluators ───────────────────────────────────────────────────────
function triggered(rule, account, ctx) {
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

    case 'renewal_overdue':
      return !!account.renewal_date && new Date(account.renewal_date) < new Date();

    case 'nps_below':
      return account.nps != null && account.nps < (cfg.threshold ?? 50);

    case 'ces_below':
      return account.ces != null && account.ces < (cfg.threshold ?? 3);

    case 'usage_below':
      return account.product_usage != null && account.product_usage < (cfg.threshold ?? 40);

    case 'open_tickets_above':
      return account.open_tickets != null && account.open_tickets > (cfg.threshold ?? 5);

    case 'churn_risk_above':
      return account.churn_risk != null && account.churn_risk > (cfg.threshold ?? 60);

    case 'arr_above':
      return account.arr != null && account.arr > (cfg.amount ?? 10000);

    case 'account_age_days':
      return daysSince(account.created_at) >= (cfg.days ?? 30);

    case 'survey_low_score': {
      const threshold = cfg.threshold ?? 6;
      return ctx.recentResponses.some(
        r => r.account_id === account.id && r.score < threshold
      );
    }

    default:
      return false;
  }
}

// ─── Text template resolver ───────────────────────────────────────────────────
function resolve(template, account) {
  return String(template)
    .replace(/\{account\}/g, account.name)
    .replace(/\{health\}/g,  account.health_score ?? '?')
    .replace(/\{nps\}/g,     account.nps           ?? '?')
    .replace(/\{ces\}/g,     account.ces            ?? '?')
    .replace(/\{usage\}/g,   account.product_usage  ?? '?')
    .replace(/\{arr\}/g,     account.arr            ?? '?')
    .replace(/\{tickets\}/g, account.open_tickets   ?? '?');
}

// ─── Email HTML template ──────────────────────────────────────────────────────
function alertEmailHtml(account, rule, body) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://pulse-sigma-two.vercel.app';
  return `
<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#0f172a">
  <div style="background:#4361ee;color:white;padding:16px 20px;border-radius:10px 10px 0 0">
    <strong style="font-size:15px">Pulse Automation Alert</strong>
  </div>
  <div style="background:#f7f8fc;border:1px solid #e2e6ef;border-top:none;padding:24px;border-radius:0 0 10px 10px">
    <p style="font-size:14px;margin:0 0 20px;line-height:1.6">${body}</p>
    <hr style="border:none;border-top:1px solid #e2e6ef;margin:0 0 16px">
    <table style="font-size:12px;color:#475569;border-collapse:collapse;width:100%">
      <tr><td style="padding:3px 0;font-weight:600;width:90px">Account</td><td>${account.name}</td></tr>
      <tr><td style="padding:3px 0;font-weight:600">Health</td><td>${account.health_score ?? '—'} / 100</td></tr>
      <tr><td style="padding:3px 0;font-weight:600">Stage</td><td>${account.stage ?? '—'}</td></tr>
      <tr><td style="padding:3px 0;font-weight:600">Rule</td><td>${rule.name}</td></tr>
    </table>
    <a href="${frontendUrl}" style="display:inline-block;margin-top:20px;background:#4361ee;color:white;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Open Pulse</a>
  </div>
  <p style="font-size:11px;color:#94a3b8;margin-top:12px;text-align:center">Sent automatically by Pulse · <a href="${frontendUrl}" style="color:#94a3b8">Manage rules</a></p>
</div>`;
}

// ─── Action executors ─────────────────────────────────────────────────────────
async function executeAction(rule, account, ctx) {
  const cfg   = rule.action_config || {};
  const today = new Date().toISOString().split('T')[0];

  switch (rule.action_type) {
    case 'log_activity': {
      const note = resolve(cfg.note || `Automation: ${rule.name}`, account);
      await supabase.from('activity_log').insert({
        user_id: rule.user_id, account_id: account.id,
        type: 'Note', note, logged_at: today,
      });
      return note;
    }

    case 'create_task': {
      const title = resolve(cfg.title || `Follow up: ${account.name}`, account);
      await supabase.from('activity_log').insert({
        user_id: rule.user_id, account_id: account.id,
        type: 'Task', note: title, logged_at: today,
      });
      return title;
    }

    case 'activate_playbook': {
      const playbookId = cfg.playbook_id || '';
      if (playbookId) {
        await supabase.from('accounts')
          .update({ active_playbook_id: playbookId })
          .eq('id', account.id);
      }
      return `Activated playbook: ${cfg.playbook_name || playbookId}`;
    }

    case 'update_stage': {
      const stage = cfg.stage || 'At Risk';
      await supabase.from('accounts')
        .update({ stage })
        .eq('id', account.id);
      return `Stage updated to: ${stage}`;
    }

    case 'email_alert': {
      const subject = resolve(cfg.subject || `Pulse Alert: ${account.name}`, account);
      const body    = resolve(cfg.body    || `Rule "${rule.name}" triggered for ${account.name}.`, account);
      const html    = alertEmailHtml(account, rule, body);

      const sent = await sendAutomationEmail(rule.user_id, ctx.profile?.email, subject, html);
      return sent ? `Email alert sent: "${subject}"` : 'Email alert skipped — no email account connected';
    }

    default:
      return null;
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────
async function firedRecently(ruleId, accountId, hours) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
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

// ─── Scope filter — account_id wins over segment_config ──────────────────────
function scopeFilter(accounts, rule) {
  if (rule.account_id) {
    return accounts.filter(a => a.id === rule.account_id);
  }
  const seg = rule.segment_config || {};
  if (!seg.plan && !seg.stage && !seg.arr_min) return accounts;
  return accounts.filter(a => {
    if (seg.plan    && a.plan  !== seg.plan)          return false;
    if (seg.stage   && a.stage !== seg.stage)         return false;
    if (seg.arr_min && (a.arr ?? 0) < seg.arr_min)    return false;
    return true;
  });
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function runAutomationEngine() {
  try {
    const { data: rules } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('enabled', true);

    if (!rules?.length) return;

    // Group rules by user
    const byUser = {};
    for (const rule of rules) {
      (byUser[rule.user_id] = byUser[rule.user_id] || []).push(rule);
    }

    for (const [userId, userRules] of Object.entries(byUser)) {
      // Fetch accounts for this user
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, name, health_score, nps, ces, product_usage, open_tickets, churn_risk, arr, last_contact, renewal_date, stage, plan, archived, created_at')
        .eq('user_id', userId)
        .eq('archived', false);

      if (!accounts?.length) continue;

      // Pre-fetch recent survey responses if any rule uses survey_low_score
      const needsSurveys = userRules.some(r => r.trigger_type === 'survey_low_score');
      let recentResponses = [];
      if (needsSurveys) {
        const since24h = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        // Get surveys for this user's accounts, then get responses for those surveys
        const { data: surveys } = await supabase
          .from('surveys')
          .select('id, account_id')
          .eq('user_id', userId);

        if (surveys?.length) {
          const surveyIds = surveys.map(s => s.id);
          const accountMap = Object.fromEntries(surveys.map(s => [s.id, s.account_id]));

          const { data: responses } = await supabase
            .from('survey_responses')
            .select('survey_id, score')
            .in('survey_id', surveyIds)
            .gte('submitted_at', since24h);

          recentResponses = (responses || []).map(r => ({
            ...r,
            account_id: accountMap[r.survey_id],
          }));
        }
      }

      // Pre-fetch CSM profile for email_alert actions
      const needsEmail = userRules.some(r => r.action_type === 'email_alert');
      let profile = null;
      if (needsEmail) {
        const { data } = await supabase
          .from('profiles')
          .select('email, full_name')
          .eq('id', userId)
          .maybeSingle();
        profile = data;
      }

      const ctx = { recentResponses, profile };

      for (const rule of userRules) {
        const cooldown      = cooldownHours(rule.trigger_type);
        const targetAccounts = scopeFilter(accounts, rule);
        for (const account of targetAccounts) {
          if (await firedRecently(rule.id, account.id, cooldown)) continue;
          if (!triggered(rule, account, ctx)) continue;

          const detail = await executeAction(rule, account, ctx);

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
