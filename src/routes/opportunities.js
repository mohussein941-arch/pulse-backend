'use strict';

const express = require('express');
const supabase = require('../supabase');
const { matchOpportunities } = require('../engine/opportunityMatcher');

const router = express.Router();

// GET /api/opportunities/:accountId
router.get('/:accountId', async (req, res, next) => {
  try {
    const opportunities = await matchOpportunities({
      orgId: req.orgId,
      accountId: req.params.accountId,
      db: supabase,
    });

    if (opportunities === null) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({ opportunities });
  } catch (err) { next(err); }
});

// POST /api/opportunities/:accountId/dismiss
router.post('/:accountId/dismiss', async (req, res, next) => {
  try {
    const { featureId } = req.body;
    if (!featureId) return res.status(400).json({ error: 'featureId is required' });

    // Verify the feature belongs to this org
    const { data: feature } = await supabase.from('features')
      .select('id')
      .eq('id', featureId)
      .eq('org_id', req.orgId)
      .maybeSingle();

    if (!feature) return res.status(404).json({ error: 'Feature not found' });

    const { error } = await supabase.from('opportunity_dismissals').upsert({
      org_id: req.orgId,
      account_id: req.params.accountId,
      feature_id: featureId,
      dismissed_by: req.userId,
      dismissed_at: new Date().toISOString(),
    }, { onConflict: 'account_id,feature_id' });

    if (error) throw error;

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
