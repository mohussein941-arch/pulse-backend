// services/context-engine/feedback.js — POST /api/ai/feedback
//
// Captures CSM accept/edit/reject on any AI-generated output.
// Updates the ai_traces row identified by trace_id.
// This is the signal used to improve model quality over time (M7+).

const express  = require('express');
const router   = express.Router();
const supabase = require('../../supabase');

const VALID_FEEDBACK = ['accept', 'edit', 'reject'];

/**
 * POST /api/ai/feedback
 * Body: { trace_id, feedback, notes? }
 *
 * Returns 204 on success.
 * Returns 400 if trace_id or feedback is invalid.
 * Returns 404 if the trace doesn't belong to req.orgId.
 */
router.post('/', async (req, res, next) => {
  try {
    const { trace_id, feedback, notes } = req.body;

    if (!trace_id)                          return res.status(400).json({ error: 'trace_id is required' });
    if (!VALID_FEEDBACK.includes(feedback)) return res.status(400).json({ error: `feedback must be one of: ${VALID_FEEDBACK.join(', ')}` });

    // Confirm the trace belongs to this org before updating
    const { data: trace } = await supabase
      .from('ai_traces')
      .select('id')
      .eq('id', trace_id)
      .eq('org_id', req.orgId)    // org_id isolation
      .maybeSingle();

    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const { error } = await supabase
      .from('ai_traces')
      .update({
        feedback,
        feedback_notes: notes || null,
        feedback_at:    new Date().toISOString(),
      })
      .eq('id', trace_id)
      .eq('org_id', req.orgId);   // second guard

    if (error) throw error;

    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
