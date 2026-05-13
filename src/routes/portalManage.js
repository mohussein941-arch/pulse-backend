// routes/portalManage.js
// Protected — CSM generates, configures, and revokes portal links.

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

// GET /api/portal/:accountId — fetch existing portal link for account
router.get('/:accountId', async (req, res) => {
  const { data, error } = await supabase
    .from('portal_links')
    .select('*')
    .eq('account_id', req.params.accountId)
    .eq('user_id', req.userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// POST /api/portal — create portal link (idempotent — returns existing if present)
router.post('/', async (req, res) => {
  const { account_id, config } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });

  const { data, error } = await supabase
    .from('portal_links')
    .insert({ user_id: req.userId, account_id, config: { ...DEFAULT_CONFIG, ...(config || {}) } })
    .select().single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('portal_links').select('*')
        .eq('account_id', account_id).eq('user_id', req.userId).maybeSingle();
      return res.json(existing);
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// PATCH /api/portal/:accountId — update config toggles
router.patch('/:accountId', async (req, res) => {
  const { data, error } = await supabase
    .from('portal_links')
    .update({ config: req.body.config })
    .eq('account_id', req.params.accountId)
    .eq('user_id', req.userId)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Portal not found' });
  res.json(data);
});

// DELETE /api/portal/:accountId — revoke portal
router.delete('/:accountId', async (req, res) => {
  const { error } = await supabase
    .from('portal_links')
    .delete()
    .eq('account_id', req.params.accountId)
    .eq('user_id', req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
