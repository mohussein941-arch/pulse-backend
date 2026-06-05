// routes/handover.js
// Public — no auth. Sales rep accesses via magic link, views handover, confirms.

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HANDOVER_FIELDS = [
  ['what_sold',          'What was sold'],
  ['why_bought',         'Why they bought / pain points'],
  ['success_definition', 'Their definition of success'],
  ['promises',           'Commitments made during sales'],
  ['red_flags',          'Red flags or concerns'],
  ['contacts',           'Contacts handed over'],
];

// ── GET /handover/:token ──────────────────────────────────────────────────────
router.get('/:token', async (req, res) => {
  const { data: plan } = await supabase
    .from('onboarding_plans')
    .select('id, handover_data, handover_fields, handover_status, handover_sales_notes, handover_sales_email, account_id')
    .eq('handover_token', req.params.token)
    .maybeSingle();

  if (!plan) return res.status(404).json({ error: 'Handover link not found or expired' });

  // Fetch account name for display
  const { data: account } = await supabase
    .from('accounts').select('name, industry, plan, arr').eq('id', plan.account_id).maybeSingle();

  const data = plan.handover_data || {};
  // Per-plan custom field set if present, else the canonical default.
  const FIELDS = Array.isArray(plan.handover_fields) && plan.handover_fields.length
    ? plan.handover_fields.filter(f => f && f.key).map(f => [f.key, f.label || f.key])
    : HANDOVER_FIELDS;
  const filled = FIELDS.filter(([k]) => data[k]?.trim()).length;
  const completeness = FIELDS.length ? Math.round((filled / FIELDS.length) * 100) : 0;

  res.json({
    account: account ? { name: account.name, industry: account.industry, plan: account.plan, arr: account.arr } : null,
    handoverData:     data,
    fields:           FIELDS.map(([k, label]) => ({ key: k, label, value: data[k] || '' })),
    status:           plan.handover_status,
    salesNotes:       plan.handover_sales_notes || '',
    completeness,
  });
});

// ── POST /handover/:token/confirm ─────────────────────────────────────────────
router.post('/:token/confirm', async (req, res) => {
  const { notes } = req.body;

  const { data: plan } = await supabase
    .from('onboarding_plans')
    .select('id, handover_status')
    .eq('handover_token', req.params.token)
    .maybeSingle();

  if (!plan) return res.status(404).json({ error: 'Handover link not found' });

  const { error } = await supabase.from('onboarding_plans').update({
    handover_status:       'confirmed',
    handover_confirmed_at: new Date().toISOString(),
    handover_sales_notes:  notes || null,
  }).eq('id', plan.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
