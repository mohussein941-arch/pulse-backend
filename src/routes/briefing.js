// routes/briefing.js — CSM briefing: read today's items, update status, manage settings

const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { generateBriefing } = require('../engine/briefingRunner');
const { schemas, validate, validateUuidParam } = require('../utils/validate');
const { audit } = require('../middleware/audit');

function todayStr() { return new Date().toISOString().split('T')[0]; }

const SUGGESTED_ACTIONS = {
  renewal_critical:    'Confirm renewal terms and send the agreement',
  renewal_warning:     'Start the renewal conversation',
  churn_risk_critical: 'Open a retention conversation to understand the risk',
  health_critical:     'Schedule an urgent check-in on account health',
  health_warning:      'Schedule a check-in on declining health',
  health_declining:    'Check in early — health is trending down before the score shows it',
  no_contact_critical: 'Reach out to re-establish contact',
  no_contact_warning:  'Send a quick touch-base',
  low_nps:             'Follow up on the low NPS and address the dissatisfaction',
  task_overdue:        'Clear the overdue task',
  task_due_today:      'Complete the task due today',
};

// GET /api/briefing/today — fetch today's briefing items (generates on demand if missing)
router.get('/today', async (req, res, next) => {
  try {
    const today = todayStr();

    let { data: items } = await supabase
      .from('briefing_items')
      .select('*, accounts(name)')
      .eq('user_id', req.userId)
      .eq('briefing_date', today)
      .order('current_score', { ascending: false });

    // Generate on-demand if nothing exists yet today
    if (!items || items.length === 0) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, email, full_name, briefing_config')
        .eq('id', req.userId)
        .maybeSingle();

      if (profile) {
        await generateBriefing(profile, today, profile.briefing_config || {});
        const { data: fresh } = await supabase
          .from('briefing_items')
          .select('*, accounts(name)')
          .eq('user_id', req.userId)
          .eq('briefing_date', today)
          .order('current_score', { ascending: false });
        items = fresh || [];
      }
    }

    res.json(items.map(shapeItem));
  } catch (err) { next(err); }
});

// GET /api/briefing/priority — ranked accounts with top signal and suggested action
router.get('/priority', async (req, res, next) => {
  try {
    const today = todayStr();

    let { data: items } = await supabase
      .from('briefing_items')
      .select('*, accounts(name)')
      .eq('user_id', req.userId)
      .eq('briefing_date', today)
      .eq('status', 'pending')
      .order('current_score', { ascending: false });

    // Generate on-demand if nothing exists yet today
    if (!items || items.length === 0) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, email, full_name, briefing_config')
        .eq('id', req.userId)
        .maybeSingle();

      if (profile) {
        await generateBriefing(profile, today, profile.briefing_config || {});
        const { data: fresh } = await supabase
          .from('briefing_items')
          .select('*, accounts(name)')
          .eq('user_id', req.userId)
          .eq('briefing_date', today)
          .eq('status', 'pending')
          .order('current_score', { ascending: false });
        items = fresh || [];
      }
    }

    const actionable = (items || []).filter(i => i.category !== 'win');

    // Items are already ordered current_score DESC; first seen per account = highest score
    const byAccount = new Map();
    for (const item of actionable) {
      if (!item.account_id) continue;
      if (!byAccount.has(item.account_id)) byAccount.set(item.account_id, item);
    }

    const accounts = [...byAccount.values()]
      .map(item => ({
        account_id:       item.account_id,
        account_name:     item.accounts?.name || null,
        priority_score:   parseFloat(item.current_score),
        signal_type:      item.signal_type,
        reason:           item.signal_detail,
        suggested_action: SUGGESTED_ACTIONS[item.signal_type] || 'Review the account',
      }))
      .sort((a, b) => b.priority_score - a.priority_score);

    res.json({ accounts });
  } catch (err) { next(err); }
});

// GET /api/briefing/history — past briefing dates
router.get('/history', async (req, res, next) => {
  try {
    const { data } = await supabase
      .from('briefing_items')
      .select('briefing_date')
      .eq('user_id', req.userId)
      .order('briefing_date', { ascending: false });

    const dates = [...new Set((data || []).map(r => r.briefing_date))];
    res.json(dates);
  } catch (err) { next(err); }
});

// GET /api/briefing/date/:date — fetch items for a specific past date
router.get('/date/:date', async (req, res, next) => {
  try {
    const { data } = await supabase
      .from('briefing_items')
      .select('*, accounts(name)')
      .eq('user_id', req.userId)
      .eq('briefing_date', req.params.date)
      .order('current_score', { ascending: false });

    res.json((data || []).map(shapeItem));
  } catch (err) { next(err); }
});

// PATCH /api/briefing/items/:id — mark done / snooze / dismiss
router.patch('/items/:id', validateUuidParam('id'), validate(schemas.briefingItemUpdate), async (req, res, next) => {
  try {
    const { status, snoozeDays } = req.body;

    const updates = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === 'snoozed' && snoozeDays) {
      const snoozeDate = new Date();
      snoozeDate.setDate(snoozeDate.getDate() + snoozeDays);
      updates.snoozed_until = snoozeDate.toISOString().split('T')[0];
    }

    const { data, error } = await supabase
      .from('briefing_items')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select().single();

    if (error) throw error;
    if (!data)  return res.status(404).json({ error: 'Item not found' });
    audit(req.userId, 'briefing.item_updated', { resourceType: 'briefing_item', resourceId: req.params.id, meta: { status }, req });
    res.json(shapeItem(data));
  } catch (err) { next(err); }
});

// GET /api/briefing/settings
router.get('/settings', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('briefing_config')
      .eq('id', req.userId)
      .maybeSingle();

    if (error) throw error;
    res.json(data?.briefing_config || defaultConfig());
  } catch (err) { next(err); }
});

// PATCH /api/briefing/settings
router.patch('/settings', validate(schemas.briefingSettings), async (req, res, next) => {
  try {
    const { enabled, days, hour, timezone, email_enabled } = req.body;
    const current = await getConfig(req.userId);

    const updated = {
      ...current,
      ...(enabled       !== undefined && { enabled }),
      ...(days          !== undefined && { days }),
      ...(hour          !== undefined && { hour }),
      ...(timezone      !== undefined && { timezone }),
      ...(email_enabled !== undefined && { email_enabled }),
    };

    const { data, error } = await supabase
      .from('profiles')
      .update({ briefing_config: updated, updated_at: new Date().toISOString() })
      .eq('id', req.userId)
      .select('briefing_config').single();

    if (error) throw error;
    res.json(data.briefing_config);
  } catch (err) { next(err); }
});

async function getConfig(userId) {
  const { data } = await supabase
    .from('profiles').select('briefing_config').eq('id', userId).maybeSingle();
  return data?.briefing_config || defaultConfig();
}

function defaultConfig() {
  return { enabled: false, days: [0,1,2,3,4], hour: 7, timezone: 'Asia/Dubai', email_enabled: false };
}

function shapeItem(i) {
  return {
    id:           i.id,
    briefingDate: i.briefing_date,
    category:     i.category,
    signalType:   i.signal_type,
    signalDetail: i.signal_detail,
    accountId:    i.account_id || null,
    accountName:  i.accounts?.name || null,
    baseScore:    parseFloat(i.base_score),
    carryDays:    i.carry_days,
    currentScore: parseFloat(i.current_score),
    status:       i.status,
    snoozedUntil: i.snoozed_until || null,
  };
}

module.exports = router;
