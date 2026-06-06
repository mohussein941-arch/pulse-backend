// engine/surveyScheduler.js
// Evaluates survey_schedules and auto-creates + sends surveys to primary stakeholders.
// Runs daily at 09:00.
//
// AI_HOOK — buildSurveyMessage() returns a static intro line.
// When AI is configured, replace it with:
//   const { callAI } = require('../utils/ai');
//   message = await callAI(aiConfig, buildSurveyMessagePrompt(account, schedule, stakeholder));

const { createClient } = require('@supabase/supabase-js');
const axios            = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE_URL     = () => process.env.FRONTEND_URL || 'http://localhost:5174';
const TYPE_LABELS  = { NPS: 'Net Promoter Score', CES: 'Customer Effort Score', CSAT: 'Customer Satisfaction' };

// ─── Template message builder ─────────────────────────────────────────────────
// AI_HOOK: replace with callAI to personalise based on account context
function buildSurveyMessage(account, schedule, stakeholder) {
  const first = stakeholder?.name?.split(' ')[0] || 'there';
  const label = TYPE_LABELS[schedule.survey_type] || schedule.survey_type;
  return `Hi ${first}, we have a quick ${label} survey for ${account.name}. It takes less than 60 seconds.`;
}

// ─── Create survey + send email ───────────────────────────────────────────────
async function createAndSendSurvey(userId, account, schedule, stakeholder) {
  const { data: survey, error } = await supabase
    .from('surveys')
    .insert({
      user_id:         userId,
      account_id:      account.id,
      account_name:    account.name,
      type:            schedule.survey_type,
      custom_question: schedule.custom_question || null,
      status:          'active',
      source:          'schedule',
    })
    .select()
    .single();

  if (error) throw error;

  const link = `${BASE_URL()}/survey/${survey.token}`;

  // Log activity regardless of email availability
  await supabase.from('activity_log').insert({
    user_id:    userId,
    account_id: account.id,
    type:       'Survey',
    source:     'automation',
    note:       `Auto-scheduled ${schedule.survey_type} survey created${stakeholder?.email ? ` and sent to ${stakeholder.email}` : ' (no recipient email)'}`,
    logged_at:  new Date().toISOString().split('T')[0],
  });

  // Send via Resend if we have an email + key
  if (!stakeholder?.email || !process.env.RESEND_API_KEY) return;

  const message = buildSurveyMessage(account, schedule, stakeholder);

  await axios.post('https://api.resend.com/emails', {
    from:    process.env.RESEND_FROM_EMAIL || 'surveys@pulse.app',
    to:      stakeholder.email,
    subject: `Quick ${schedule.survey_type} survey — ${account.name}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <h2 style="color:#0f172a;margin-bottom:8px;">We'd love your feedback</h2>
        <p style="color:#475569;line-height:1.6;">${message}</p>
        <a href="${link}" style="display:inline-block;margin-top:24px;background:#4361ee;color:white;
          padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
          Take the survey →
        </a>
        <p style="color:#94a3b8;font-size:12px;margin-top:32px;">Or copy this link: ${link}</p>
      </div>`,
  }, {
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

// ─── Segment filter ───────────────────────────────────────────────────────────
function matchesSegment(account, seg) {
  if (!seg) return true;
  if (seg.plan    && account.plan  !== seg.plan)       return false;
  if (seg.stage   && account.stage !== seg.stage)      return false;
  if (seg.arr_min && (account.arr  || 0) < seg.arr_min) return false;
  return true;
}

// ─── Fire decision — should this schedule send for this account now? ──────────
function shouldFire(schedule, account, lastSurveyDate) {
  const cfg       = schedule.trigger_config || {};
  const daysSince = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : Infinity;
  const daysUntil = d => d ? Math.floor((new Date(d).getTime() - Date.now()) / 86400000) : Infinity;

  switch (schedule.trigger_type) {
    case 'onboarding_complete': {
      const age   = daysSince(account.created_at);
      const delay = cfg.days ?? 30;
      return age >= delay && daysSince(lastSurveyDate) > 60;
    }
    case 'recurring': {
      const recurrence = cfg.recurrence_days ?? 90;
      return daysSince(lastSurveyDate) >= recurrence;
    }
    case 'renewal_approaching': {
      const d         = daysUntil(account.renewal_date);
      const threshold = cfg.days_before ?? 30;
      return d >= 0 && d <= threshold && daysSince(lastSurveyDate) > threshold;
    }
    case 'health_recovery': {
      const min = cfg.min_health ?? 70;
      return (account.health_score ?? 0) >= min && daysSince(lastSurveyDate) > 30;
    }
    default:
      return false;
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function runSurveyScheduler() {
  try {
    const { data: schedules } = await supabase
      .from('survey_schedules')
      .select('*')
      .eq('enabled', true);

    if (!schedules?.length) return;

    const byUser = {};
    for (const s of schedules) (byUser[s.user_id] = byUser[s.user_id] || []).push(s);

    for (const [userId, userSchedules] of Object.entries(byUser)) {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, name, health_score, nps, plan, stage, arr, renewal_date, created_at, escalation_status')
        .eq('user_id', userId)
        .eq('archived', false);

      if (!accounts?.length) continue;

      for (const schedule of userSchedules) {
        const eligible = accounts.filter(a => matchesSegment(a, schedule.segment_config));

        for (const account of eligible) {
          // Find most recent survey of this type for this account
          const { data: lastSurveys } = await supabase
            .from('surveys')
            .select('created_at')
            .eq('user_id', userId)
            .eq('account_id', account.id)
            .eq('type', schedule.survey_type)
            .order('created_at', { ascending: false })
            .limit(1);

          const lastSurveyDate = lastSurveys?.[0]?.created_at || null;
          if (account.escalation_status === 'open') continue;   // paused — account is escalated
          if (!shouldFire(schedule, account, lastSurveyDate)) continue;

          // Get primary stakeholder
          const { data: stakeholders } = await supabase
            .from('stakeholders')
            .select('name, email, role')
            .eq('account_id', account.id)
            .eq('user_id', userId);

          const stakeholder = stakeholders?.find(s => s.role === 'Champion')
            || stakeholders?.[0]
            || null;

          try {
            await createAndSendSurvey(userId, account, schedule, stakeholder);
          } catch (err) {
            console.error(`[survey-scheduler] failed for ${account.name}:`, err.message);
          }
        }

        await supabase
          .from('survey_schedules')
          .update({ last_run_at: new Date().toISOString() })
          .eq('id', schedule.id);
      }
    }

    console.log(`[survey-scheduler] tick complete — ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[survey-scheduler] error:', err.message);
  }
}

module.exports = { runSurveyScheduler };
