// routes/schedules.js
// CRUD for survey_schedules and digest_schedules.
// All routes are user-scoped (req.userId).

const express  = require('express');
const supabase = require('../supabase');

const router = express.Router();

// ════════════════════════════════════════════════════════════════════════
// SURVEY SCHEDULES  —  /api/schedules/surveys
// ════════════════════════════════════════════════════════════════════════

// GET /api/schedules/surveys
router.get('/surveys', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('survey_schedules')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ schedules: data || [] });
  } catch (err) { next(err); }
});

// POST /api/schedules/surveys
router.post('/surveys', async (req, res, next) => {
  try {
    const { name, survey_type, trigger_type, trigger_config, segment_config, custom_question } = req.body;

    if (!name || !survey_type || !trigger_type) {
      return res.status(400).json({ error: 'name, survey_type, and trigger_type are required' });
    }
    if (!['NPS', 'CES', 'CSAT'].includes(survey_type)) {
      return res.status(400).json({ error: 'survey_type must be NPS, CES, or CSAT' });
    }

    const { data, error } = await supabase
      .from('survey_schedules')
      .insert({
        user_id:         req.userId,
        name,
        survey_type,
        trigger_type,
        trigger_config:  trigger_config  || {},
        segment_config:  segment_config  || {},
        custom_question: custom_question || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ schedule: data });
  } catch (err) { next(err); }
});

// PATCH /api/schedules/surveys/:id
router.patch('/surveys/:id', async (req, res, next) => {
  try {
    const allowed = {};
    const fields  = ['name', 'survey_type', 'trigger_type', 'trigger_config', 'segment_config', 'custom_question', 'enabled'];
    fields.forEach(f => { if (f in req.body) allowed[f] = req.body[f]; });

    const { error } = await supabase
      .from('survey_schedules')
      .update(allowed)
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/schedules/surveys/:id
router.delete('/surveys/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('survey_schedules')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// DIGEST SCHEDULES  —  /api/schedules/digests
// ════════════════════════════════════════════════════════════════════════

// GET /api/schedules/digests
router.get('/digests', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('digest_schedules')
      .select('*, accounts(id, name, plan, health_score)')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ schedules: data || [] });
  } catch (err) { next(err); }
});

// POST /api/schedules/digests
router.post('/digests', async (req, res, next) => {
  try {
    const { account_id, frequency, auto_send } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    const { data, error } = await supabase
      .from('digest_schedules')
      .insert({
        user_id:   req.userId,
        account_id,
        frequency: frequency || 'monthly',
        auto_send: auto_send ?? false,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ schedule: data });
  } catch (err) { next(err); }
});

// PATCH /api/schedules/digests/:id
router.patch('/digests/:id', async (req, res, next) => {
  try {
    const allowed = {};
    ['frequency', 'auto_send', 'enabled'].forEach(f => {
      if (f in req.body) allowed[f] = req.body[f];
    });

    const { error } = await supabase
      .from('digest_schedules')
      .update(allowed)
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/schedules/digests/:id
router.delete('/digests/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('digest_schedules')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
