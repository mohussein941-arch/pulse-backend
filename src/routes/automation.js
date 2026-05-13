// routes/automation.js
// CRUD for automation rules + recent activity log

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/automation/rules
router.get('/rules', async (req, res) => {
  const { data, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/automation/rules
router.post('/rules', async (req, res) => {
  const { name, trigger_type, trigger_config, action_type, action_config, account_id, segment_config } = req.body;
  if (!name || !trigger_type || !action_type) {
    return res.status(400).json({ error: 'name, trigger_type and action_type are required' });
  }
  const { data, error } = await supabase
    .from('automation_rules')
    .insert({
      user_id: req.userId, name, trigger_type,
      trigger_config:  trigger_config  || {},
      action_type,
      action_config:   action_config   || {},
      account_id:      account_id      || null,
      segment_config:  segment_config  || {},
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/automation/rules/:id
router.patch('/rules/:id', async (req, res) => {
  const allowed = ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'enabled', 'account_id', 'segment_config'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from('automation_rules')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Rule not found' });
  res.json(data);
});

// DELETE /api/automation/rules/:id
router.delete('/rules/:id', async (req, res) => {
  const { error } = await supabase
    .from('automation_rules')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// GET /api/automation/log  — recent 50 entries for this user
router.get('/log', async (req, res) => {
  const { data, error } = await supabase
    .from('automation_log')
    .select('*')
    .eq('user_id', req.userId)
    .order('fired_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
