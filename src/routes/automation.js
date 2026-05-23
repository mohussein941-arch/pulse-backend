// routes/automation.js
// CRUD for automation rules + recent activity log
// M0b: all queries scoped to req.orgId.
// Edit/delete permissions: CSM-role users may only edit/delete rules they created
// (rule.user_id === req.userId); admins and owners may edit any rule in the org.
//
// NOTE: table name is 'automation_rules' in the DB. Migration SQL in migration_m0b.sql
// references 'automations' — verify actual table name in Supabase before running SQL.

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/automation/rules — all rules visible to org members
router.get('/rules', async (req, res) => {
  const { data, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('org_id', req.orgId)
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
      // user_id renamed to created_by in Phase 2 (Step 8); keep user_id until then
      user_id: req.userId,
      org_id:  req.orgId,
      name, trigger_type,
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
// CSM-role: may only edit rules they created. Admin/owner: may edit any rule in org.
router.patch('/rules/:id', async (req, res) => {
  // Fetch rule to check org scope and ownership for CSM permission check
  const { data: rule, error: fetchErr } = await supabase
    .from('automation_rules')
    .select('id, user_id')
    .eq('id', req.params.id)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (fetchErr || !rule) return res.status(404).json({ error: 'Rule not found' });

  // CSM-role users may only edit rules they created
  if (req.orgRole === 'csm' && rule.user_id !== req.userId) {
    return res.status(403).json({ error: 'You can only edit rules you created' });
  }

  const allowed = ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'enabled', 'account_id', 'segment_config'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from('automation_rules')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', req.orgId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Rule not found' });
  res.json(data);
});

// DELETE /api/automation/rules/:id
// CSM-role: may only delete rules they created. Admin/owner: may delete any.
router.delete('/rules/:id', async (req, res) => {
  const { data: rule, error: fetchErr } = await supabase
    .from('automation_rules')
    .select('id, user_id')
    .eq('id', req.params.id)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (fetchErr || !rule) return res.status(404).json({ error: 'Rule not found' });

  if (req.orgRole === 'csm' && rule.user_id !== req.userId) {
    return res.status(403).json({ error: 'You can only delete rules you created' });
  }

  const { error } = await supabase
    .from('automation_rules')
    .delete()
    .eq('id', req.params.id)
    .eq('org_id', req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// GET /api/automation/log — recent 50 entries for this org
router.get('/log', async (req, res) => {
  const { data, error } = await supabase
    .from('automation_log')
    .select('*')
    .eq('org_id', req.orgId)
    .order('fired_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
