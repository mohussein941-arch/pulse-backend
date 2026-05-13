// routes/portal.js
// Public — no auth required. Customer accesses via magic link token.

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_CONFIG = {
  show_health:        true,
  show_churn_risk:    false,
  show_onboarding:    true,
  show_tasks:         true,
  show_renewal:       true,
  show_survey:        true,
  show_value_goals:   false,
  show_feedback_loop: false,
};

// ── GET /portal/:token ────────────────────────────────────────────────────────
router.get('/:token', async (req, res) => {
  const { data: link } = await supabase
    .from('portal_links')
    .select('*')
    .eq('token', req.params.token)
    .maybeSingle();

  if (!link) return res.status(404).json({ error: 'Portal not found' });

  const cfg = { ...DEFAULT_CONFIG, ...link.config };

  const [accountRes, profileRes] = await Promise.all([
    supabase.from('accounts')
      .select('id, name, health_score, churn_risk, nps, ces, product_usage, open_tickets, renewal_date, arr, stage')
      .eq('id', link.account_id).eq('user_id', link.user_id).maybeSingle(),
    supabase.from('profiles')
      .select('full_name, company')
      .eq('id', link.user_id).maybeSingle(),
  ]);

  if (!accountRes.data) return res.status(404).json({ error: 'Account not found' });

  const account = accountRes.data;

  // Onboarding + customer tasks
  let onboarding = null;
  let tasks = [];
  if (cfg.show_onboarding || cfg.show_tasks) {
    const { data: plan } = await supabase
      .from('onboarding_plans')
      .select('*')
      .eq('account_id', link.account_id)
      .eq('user_id', link.user_id)
      .eq('status', 'active')
      .maybeSingle();

    if (plan) {
      onboarding = plan;
      if (cfg.show_tasks) {
        const { data: taskRows } = await supabase
          .from('onboarding_tasks')
          .select('id, title, status, due_date, sort_order')
          .eq('plan_id', plan.id)
          .eq('owner', 'customer')
          .order('sort_order', { ascending: true });
        tasks = taskRows || [];
      }
    }
  }

  // Active survey prompt
  let activeSurvey = null;
  if (cfg.show_survey) {
    const { data: survey } = await supabase
      .from('surveys')
      .select('id, title, type, token')
      .eq('account_id', link.account_id)
      .eq('user_id', link.user_id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    activeSurvey = survey;
  }

  // Survey history for feedback loop
  let surveyHistory = [];
  if (cfg.show_feedback_loop) {
    const { data: surveys } = await supabase
      .from('surveys')
      .select('id, type')
      .eq('account_id', link.account_id)
      .eq('user_id', link.user_id);

    if (surveys?.length) {
      const surveyIds  = surveys.map(s => s.id);
      const typeMap    = Object.fromEntries(surveys.map(s => [s.id, s.type]));
      const { data: responses } = await supabase
        .from('survey_responses')
        .select('survey_id, score, submitted_at')
        .in('survey_id', surveyIds)
        .order('submitted_at', { ascending: false })
        .limit(8);
      surveyHistory = (responses || []).map(r => ({
        ...r, type: typeMap[r.survey_id],
      }));
    }
  }

  res.json({
    config:       cfg,
    csm:          { full_name: profileRes.data?.full_name || '', company: profileRes.data?.company || '' },
    account: {
      name:          account.name,
      stage:         account.stage,
      health_score:  cfg.show_health       ? account.health_score  : null,
      churn_risk:    cfg.show_churn_risk   ? account.churn_risk    : null,
      nps:           cfg.show_health       ? account.nps           : null,
      ces:           cfg.show_health       ? account.ces           : null,
      product_usage: cfg.show_health       ? account.product_usage : null,
      open_tickets:  cfg.show_health       ? account.open_tickets  : null,
      renewal_date:  cfg.show_renewal      ? account.renewal_date  : null,
    },
    onboarding:   cfg.show_onboarding ? onboarding : null,
    tasks:        cfg.show_tasks      ? tasks      : [],
    activeSurvey,
    surveyHistory,
    successGoal:  cfg.show_value_goals ? (onboarding?.handover_data?.success_definition || null) : null,
  });
});

// ── PATCH /portal/:token/tasks/:taskId — customer marks task done ─────────────
router.patch('/:token/tasks/:taskId', async (req, res) => {
  const { status } = req.body;
  if (!['not_started', 'in_progress', 'done'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const { data: link } = await supabase
    .from('portal_links')
    .select('account_id, config')
    .eq('token', req.params.token)
    .maybeSingle();

  if (!link) return res.status(404).json({ error: 'Portal not found' });

  const cfg = { ...DEFAULT_CONFIG, ...link.config };
  if (!cfg.show_tasks) return res.status(403).json({ error: 'Tasks not enabled' });

  // Only customer-owned tasks on this account
  const { data: task } = await supabase
    .from('onboarding_tasks')
    .select('id')
    .eq('id', req.params.taskId)
    .eq('account_id', link.account_id)
    .eq('owner', 'customer')
    .maybeSingle();

  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { data, error } = await supabase
    .from('onboarding_tasks')
    .update({ status })
    .eq('id', req.params.taskId)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
