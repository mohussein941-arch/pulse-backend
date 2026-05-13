// routes/onboarding.js
// Onboarding plans, tasks, and account needs — all optional per account

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_PHASES = {
  handover:      { expected: null, actual: null, skipped: false },
  kickoff:       { expected: null, actual: null, skipped: false },
  configuration: { expected: null, actual: null, skipped: false },
  training:      { expected: null, actual: null, skipped: false },
  go_live:       { expected: null, actual: null, skipped: false },
  value_realized:{ expected: null, actual: null, skipped: false },
};

// ─── Hub — all active plans for the sidebar overview ─────────────────────────
router.get('/all', async (req, res) => {
  const { data: plans, error } = await supabase
    .from('onboarding_plans')
    .select('*')
    .eq('user_id', req.userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  if (!plans?.length) return res.json([]);

  const planIds = plans.map(p => p.id);
  const { data: tasks } = await supabase
    .from('onboarding_tasks')
    .select('plan_id, owner, status')
    .in('plan_id', planIds);

  const tasksByPlan = {};
  for (const t of tasks || []) {
    if (!tasksByPlan[t.plan_id]) tasksByPlan[t.plan_id] = [];
    tasksByPlan[t.plan_id].push(t);
  }

  const result = plans.map(p => {
    const pt = tasksByPlan[p.id] || [];
    return {
      ...p,
      csm_total:      pt.filter(t => t.owner === 'csm').length,
      csm_done:       pt.filter(t => t.owner === 'csm'      && t.status === 'done').length,
      customer_total: pt.filter(t => t.owner === 'customer').length,
      customer_done:  pt.filter(t => t.owner === 'customer' && t.status === 'done').length,
    };
  });

  res.json(result);
});

// ─── Single account — plan + tasks + needs ────────────────────────────────────
router.get('/account/:accountId', async (req, res) => {
  const { accountId } = req.params;

  const [planRes, needsRes] = await Promise.all([
    supabase.from('onboarding_plans').select('*')
      .eq('user_id', req.userId).eq('account_id', accountId)
      .eq('status', 'active').maybeSingle(),
    supabase.from('account_needs').select('*')
      .eq('user_id', req.userId).eq('account_id', accountId)
      .order('created_at', { ascending: false }),
  ]);

  if (planRes.error) return res.status(500).json({ error: planRes.error.message });

  const plan  = planRes.data;
  let tasks   = [];

  if (plan) {
    const { data } = await supabase
      .from('onboarding_tasks').select('*')
      .eq('plan_id', plan.id)
      .order('sort_order', { ascending: true });
    tasks = data || [];
  }

  res.json({ plan, tasks, needs: needsRes.data || [] });
});

// ─── Plans ────────────────────────────────────────────────────────────────────
router.post('/plan', async (req, res) => {
  const { account_id, go_live_target } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  const { data, error } = await supabase
    .from('onboarding_plans')
    .insert({
      user_id:       req.userId,
      account_id,
      go_live_target: go_live_target || null,
      phases:         DEFAULT_PHASES,
      handover_data:  {},
    })
    .select().single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An active onboarding plan already exists for this account' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

router.patch('/plan/:id', async (req, res) => {
  const allowed = ['current_phase','phases','handover_data','go_live_target','go_live_actual','status'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from('onboarding_plans')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Plan not found' });
  res.json(data);
});

router.delete('/plan/:id', async (req, res) => {
  const { error } = await supabase
    .from('onboarding_plans')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ─── Tasks ────────────────────────────────────────────────────────────────────
router.post('/tasks', async (req, res) => {
  const { plan_id, account_id, title, owner = 'csm', due_date, sort_order = 0 } = req.body;
  if (!plan_id || !title) return res.status(400).json({ error: 'plan_id and title are required' });

  const { data, error } = await supabase
    .from('onboarding_tasks')
    .insert({ user_id: req.userId, plan_id, account_id, title, owner, due_date: due_date || null, sort_order })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/tasks/:id', async (req, res) => {
  const allowed = ['title','description','owner','status','due_date','sort_order','note'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from('onboarding_tasks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Task not found' });
  res.json(data);
});

router.delete('/tasks/:id', async (req, res) => {
  const { error } = await supabase
    .from('onboarding_tasks').delete()
    .eq('id', req.params.id).eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ─── Account needs ────────────────────────────────────────────────────────────
router.post('/needs', async (req, res) => {
  const { account_id, category = 'business', description, priority = 'medium' } = req.body;
  if (!account_id || !description) return res.status(400).json({ error: 'account_id and description are required' });

  const { data, error } = await supabase
    .from('account_needs')
    .insert({ user_id: req.userId, account_id, category, description, priority })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/needs/:id', async (req, res) => {
  const allowed = ['category','description','priority','status'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from('account_needs')
    .update(updates)
    .eq('id', req.params.id).eq('user_id', req.userId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Need not found' });
  res.json(data);
});

router.delete('/needs/:id', async (req, res) => {
  const { error } = await supabase
    .from('account_needs').delete()
    .eq('id', req.params.id).eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
