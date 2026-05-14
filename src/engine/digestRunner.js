// engine/digestRunner.js
// Builds monthly/quarterly stakeholder health digests for accounts with
// an active digest_schedule. Either sends directly (auto_send=true) or adds
// to the outreach_queue for CSM review.
// Runs daily at 08:00.
//
// AI_HOOK — generateDigestHtml() currently produces a structured template.
// When AI is configured, replace the narrative paragraph inside it with:
//   const { callAI } = require('../utils/ai');
//   const narrative = await callAI(aiConfig, buildDigestPrompt(account, metrics));
// The outer HTML scaffold stays; only the narrative section is AI-generated.

const { createClient } = require('@supabase/supabase-js');
const axios            = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── HTML digest builder ──────────────────────────────────────────────────────
// AI_HOOK: the narrative paragraph near the bottom is where AI text slots in.
function generateDigestHtml(account, metrics) {
  const hColor = metrics.healthScore >= 70 ? '#059669'
    : metrics.healthScore >= 45 ? '#d97706' : '#dc2626';

  // AI_HOOK: replace this static text with callAI result
  const narrative = metrics.healthScore >= 70
    ? 'Your account is in great shape — keep up the momentum!'
    : metrics.healthScore >= 45
      ? "We're actively monitoring your account and here to support you."
      : "We'd love to connect and discuss how we can improve your experience.";

  const milestonesHtml = (metrics.milestones || []).length > 0
    ? `<div style="margin-bottom:20px">
        <h3 style="font-size:14px;font-weight:600;margin:0 0 10px;color:#0f172a">Success Plan</h3>
        ${metrics.milestones.map(m => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9">
            <span style="font-size:14px">${m.done ? '✅' : '⬜'}</span>
            <span style="font-size:13px;color:${m.done ? '#059669' : '#475569'}">${m.text}</span>
          </div>`).join('')}
       </div>`
    : '';

  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#0f172a">
  <div style="background:#4361ee;color:white;padding:20px 24px;border-radius:12px 12px 0 0">
    <h2 style="margin:0;font-size:18px">${account.name} — Health Update</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:.8">
      ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
    </p>
  </div>
  <div style="background:#f7f8fc;border:1px solid #e2e6ef;border-top:none;padding:28px;border-radius:0 0 12px 12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
      <div style="background:white;border:1px solid #e2e6ef;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:${hColor}">${metrics.healthScore ?? '—'}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Health Score</div>
      </div>
      <div style="background:white;border:1px solid #e2e6ef;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#4361ee">${metrics.productUsage ?? '—'}%</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Product Usage</div>
      </div>
      <div style="background:white;border:1px solid #e2e6ef;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#0f172a">${metrics.nps ?? '—'}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">NPS Score</div>
      </div>
      <div style="background:white;border:1px solid #e2e6ef;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#0f172a">${metrics.openTickets ?? 0}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Open Tickets</div>
      </div>
    </div>
    ${milestonesHtml}
    <p style="font-size:13px;color:#475569;line-height:1.6;margin:0">${narrative}</p>
  </div>
  <p style="font-size:11px;color:#94a3b8;margin-top:12px;text-align:center">
    Sent by your Customer Success team via Pulse
  </p>
</div>`;
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function runDigestRunner() {
  try {
    const { data: schedules } = await supabase
      .from('digest_schedules')
      .select('*, accounts(id, name, health_score, nps, ces, product_usage, open_tickets, arr, plan, stage)')
      .eq('enabled', true);

    if (!schedules?.length) return;

    const now = new Date();
    let sent = 0, queued = 0;

    for (const schedule of schedules) {
      if (!schedule.accounts) continue;
      const account  = schedule.accounts;
      const lastSent = schedule.last_sent_at ? new Date(schedule.last_sent_at) : null;

      // Check frequency window
      const daysSinceLast = lastSent
        ? Math.floor((now - lastSent) / 86400000)
        : Infinity;
      const requiredDays = schedule.frequency === 'quarterly' ? 85 : 28;
      if (daysSinceLast < requiredDays) continue;

      // Fetch milestones for success plan section
      const { data: milestones } = await supabase
        .from('milestones')
        .select('text, done')
        .eq('account_id', account.id)
        .eq('user_id', schedule.user_id)
        .order('sort_order');

      const metrics = {
        healthScore:  account.health_score,
        nps:          account.nps,
        productUsage: account.product_usage,
        openTickets:  account.open_tickets,
        milestones:   milestones || [],
      };

      const label   = schedule.frequency === 'quarterly' ? 'Quarterly' : 'Monthly';
      const subject = `${account.name} — ${label} Health Update`;
      const html    = generateDigestHtml(account, metrics);

      if (schedule.auto_send && process.env.RESEND_API_KEY) {
        // Send directly to all stakeholders with an email
        const { data: stakeholders } = await supabase
          .from('stakeholders')
          .select('email, name')
          .eq('account_id', account.id)
          .eq('user_id', schedule.user_id)
          .not('email', 'is', null);

        for (const s of (stakeholders || [])) {
          try {
            await axios.post('https://api.resend.com/emails', {
              from:    process.env.RESEND_FROM_EMAIL || 'updates@pulse.app',
              to:      s.email,
              subject,
              html,
            }, {
              headers: {
                Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
              },
            });
          } catch (err) {
            console.error(`[digest] send failed to ${s.email}:`, err.message);
          }
        }

        await supabase.from('activity_log').insert({
          user_id:    schedule.user_id,
          account_id: account.id,
          type:       'Email',
          source:     'automation',
          note:       `${label} health digest sent to stakeholders`,
          logged_at:  now.toISOString().split('T')[0],
        });
        sent++;
      } else {
        // Add to outreach_queue for CSM approval
        await supabase.from('outreach_queue').insert({
          user_id:      schedule.user_id,
          account_id:   account.id,
          account_name: account.name,
          trigger_type: 'digest',
          subject,
          body_draft:   html,
          status:       'pending',
          ai_generated: false, // AI_HOOK: true when AI generates narrative
          metadata:     { metrics, frequency: schedule.frequency },
        });
        queued++;
      }

      await supabase
        .from('digest_schedules')
        .update({ last_sent_at: now.toISOString() })
        .eq('id', schedule.id);
    }

    console.log(`[digest] tick complete — ${sent} sent, ${queued} queued — ${now.toISOString()}`);
  } catch (err) {
    console.error('[digest] runner error:', err.message);
  }
}

module.exports = { runDigestRunner };
