// routes/outreach.js
// CRUD + send for the outreach_queue table.
// All routes are user-scoped (req.userId).

const express  = require('express');
const supabase = require('../supabase');
const { sendAutomationEmail } = require('../utils/emailSender');

const router = express.Router();

// ── GET /api/outreach — list queue items ──────────────────────────────────────
// ?status=pending|approved|sent|dismissed   (optional filter)
// ?limit=N                                  (default 100)
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 100 } = req.query;

    let q = supabase
      .from('outreach_queue')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ items: data || [] });
  } catch (err) { next(err); }
});

// ── PATCH /api/outreach/:id — update status / edit draft ─────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    const { status, subject, body_draft } = req.body;
    if (status     !== undefined) updates.status     = status;
    if (subject    !== undefined) updates.subject    = subject;
    if (body_draft !== undefined) updates.body_draft = body_draft;

    const { error } = await supabase
      .from('outreach_queue')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/outreach/:id/send — send via CSM's connected email ──────────────
// Body: { recipientEmail?, recipientName? }
// Falls back to recipient_email stored on the item if not provided in body.
router.post('/:id/send', async (req, res, next) => {
  try {
    const { data: item, error: fetchErr } = await supabase
      .from('outreach_queue')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (fetchErr || !item) return res.status(404).json({ error: 'Item not found' });
    if (item.status === 'sent') return res.status(400).json({ error: 'Already sent' });

    const toEmail = req.body.recipientEmail || item.recipient_email;
    if (!toEmail) {
      return res.status(400).json({
        error: 'No recipient email. Provide recipientEmail in the request or add a stakeholder email for this account.',
      });
    }

    // Convert plain-text body to simple HTML if it doesn't already contain tags
    const htmlBody = item.body_draft.trimStart().startsWith('<')
      ? item.body_draft
      : `<div style="font-family:sans-serif;font-size:14px;color:#0f172a;line-height:1.7">
          ${item.body_draft
            .split('\n')
            .map(l => l.trim() ? `<p style="margin:0 0 10px">${l}</p>` : '<br>')
            .join('')}
        </div>`;

    const sent = await sendAutomationEmail(req.userId, toEmail, item.subject, htmlBody);

    if (!sent) {
      return res.status(400).json({
        error: 'No connected email account found. Connect Gmail or Outlook in Settings to send outreach.',
      });
    }

    const toName = req.body.recipientName || item.recipient_name;

    await supabase.from('outreach_queue').update({
      status:          'sent',
      sent_at:         new Date().toISOString(),
      recipient_email: toEmail,
      recipient_name:  toName || item.recipient_name,
      updated_at:      new Date().toISOString(),
    }).eq('id', req.params.id);

    // Auto-log the send as account activity
    if (item.account_id) {
      await supabase.from('activity_log').insert({
        user_id:    req.userId,
        account_id: item.account_id,
        type:       'Email',
        source:     'automation',
        note:       `Outreach sent: "${item.subject}"`,
        logged_at:  new Date().toISOString().split('T')[0],
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/outreach/:id — remove item ────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('outreach_queue')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
