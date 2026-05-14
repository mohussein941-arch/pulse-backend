// engine/outreachRunner.js
// Detects account signals and creates draft outreach in outreach_queue.
// Runs every 6 hours. Deduplication via cooldown prevents re-queuing the
// same signal for the same account within QUEUE_COOLDOWN_DAYS.
//
// AI_HOOK — buildDraft() currently returns template strings.
// When AI is configured, replace the body of buildDraft with:
//   const { callAI } = require('../utils/ai');
//   return await callAI(aiConfig, buildOutreachPrompt(account, triggerType, ctx));
// The outreach_queue.ai_generated flag will be set to true at that point.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const QUEUE_COOLDOWN_DAYS = 7;

// ─── Template engine ─────────────────────────────────────────────────────────
// AI_HOOK: replace this entire function with an AI call once the AI layer lands.
// The function signature, inputs, and return shape { subject, body } stay the same —
// only the implementation changes.
function buildDraft(account, triggerType, ctx) {
  const name     = account.name;
  const contact  = ctx.contactFirstName || 'there';
  const csm      = ctx.csmName || 'Your Customer Success Manager';
  const renewal  = account.renewal_date
    ? new Date(account.renewal_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'soon';

  switch (triggerType) {
    case 'health_drop':
      return {
        subject: `Checking in — ${name}`,
        body:
`Hi ${contact},

I noticed some recent changes in ${name}'s account metrics and wanted to reach out proactively.

Your current health score is ${account.health_score}/100. I'd love to schedule a quick call to understand how things are going and make sure we're supporting you in the best way possible.

Would 20 minutes this week work for you?

Best,
${csm}`,
      };

    case 'no_contact':
      return {
        subject: `Quick check-in — ${name}`,
        body:
`Hi ${contact},

It's been a while since we last connected and I just wanted to check in on how things are going at ${name}.

Is there anything I can help with, or any feedback you'd like to share?

Looking forward to hearing from you.

Best,
${csm}`,
      };

    case 'renewal_approaching':
      return {
        subject: `Your renewal is coming up — let's connect`,
        body:
`Hi ${contact},

${name}'s subscription is coming up for renewal on ${renewal}. I'd love to schedule a brief call to review the value you've seen so far, discuss any questions, and plan what the next chapter looks like together.

Are you available for a 30-minute conversation this week or next?

Best,
${csm}`,
      };

    case 'nps_drop':
      return {
        subject: `Following up on your recent feedback`,
        body:
`Hi ${contact},

Thank you for your recent feedback. I noticed your satisfaction score has dipped and I take that seriously — it tells me there's something we can do better.

Could we schedule a quick 15-minute call this week? I'd genuinely like to understand what's not working and how we can improve your experience.

Best,
${csm}`,
      };

    case 'usage_drop':
      return {
        subject: `Making sure ${name} is getting full value`,
        body:
`Hi ${contact},

I noticed product usage at ${name} has dipped recently. Sometimes this signals a need for additional onboarding, new team members joining, or just a quick refresher on some features.

I'd love to jump on a short call to walk through any questions and ensure your team is getting everything possible out of the platform.

Best,
${csm}`,
      };

    case 'playbook_suggested':
      return {
        subject: `Let's set ${name} up for the next stage`,
        body:
`Hi ${contact},

Based on where ${name} is in your journey, I think now is a great time to be intentional about driving success together.

I have a success plan tailored for accounts at your stage — I'd love to walk you through it. Would a 30-minute call work?

Best,
${csm}`,
      };

    default:
      return {
        subject: `Checking in — ${name}`,
        body:
`Hi ${contact},

I wanted to reach out and check in on how things are going at ${name}. Let me know if there's anything I can help with.

Best,
${csm}`,
      };
  }
}

// ─── Signal detection — returns list of triggerType strings ──────────────────
function detectSignals(account) {
  const signals   = [];
  const daysSince = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : Infinity;
  const daysUntil = d => d ? Math.floor((new Date(d).getTime() - Date.now()) / 86400000) : Infinity;

  if ((account.health_score ?? 100) < 45)                                 signals.push('health_drop');
  if (daysSince(account.last_contact) >= 21)                              signals.push('no_contact');
  if ((account.nps ?? 100) < 35)                                          signals.push('nps_drop');
  if ((account.product_usage ?? 100) < 30)                                signals.push('usage_drop');
  const d = daysUntil(account.renewal_date);
  if (d >= 0 && d <= 60)                                                  signals.push('renewal_approaching');
  if ((account.health_score ?? 100) < 50 && !account.active_playbook_id) signals.push('playbook_suggested');

  return signals;
}

// ─── Deduplication — was this (account, trigger) queued recently? ─────────────
async function recentlyQueued(userId, accountId, triggerType) {
  const since = new Date(Date.now() - QUEUE_COOLDOWN_DAYS * 86400000).toISOString();
  const { data } = await supabase
    .from('outreach_queue')
    .select('id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('trigger_type', triggerType)
    .in('status', ['pending', 'approved', 'sent'])
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// ─── Process one user ─────────────────────────────────────────────────────────
async function runOutreachForUser(userId, accounts) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle();

  const csmName = profile?.full_name || 'Your Customer Success Manager';
  let queued = 0;

  for (const account of accounts) {
    const signals = detectSignals(account);
    if (!signals.length) continue;

    // Fetch primary stakeholder for personalisation
    const { data: stakeholders } = await supabase
      .from('stakeholders')
      .select('name, email, role')
      .eq('account_id', account.id)
      .eq('user_id', userId);

    const primary = stakeholders?.find(s => ['Champion', 'Economic Buyer'].includes(s.role))
      || stakeholders?.[0]
      || null;

    const ctx = {
      csmName,
      contactFirstName: primary?.name?.split(' ')[0] || 'there',
      recipientEmail:   primary?.email || null,
      recipientName:    primary?.name  || null,
    };

    for (const triggerType of signals) {
      if (await recentlyQueued(userId, account.id, triggerType)) continue;

      const draft = buildDraft(account, triggerType, ctx);

      await supabase.from('outreach_queue').insert({
        user_id:         userId,
        account_id:      account.id,
        account_name:    account.name,
        trigger_type:    triggerType,
        subject:         draft.subject,
        body_draft:      draft.body,
        recipient_email: ctx.recipientEmail,
        recipient_name:  ctx.recipientName,
        status:          'pending',
        ai_generated:    false, // AI_HOOK: flip to true when callAI is used
        metadata: {
          health_score:  account.health_score,
          nps:           account.nps,
          product_usage: account.product_usage,
          renewal_date:  account.renewal_date,
          arr:           account.arr,
          plan:          account.plan,
        },
      });
      queued++;
    }
  }

  return queued;
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function runOutreachRunner() {
  try {
    // Collect all distinct user IDs with non-archived accounts
    const { data: rows } = await supabase
      .from('accounts')
      .select('user_id')
      .eq('archived', false);

    if (!rows?.length) return;

    const userIds = [...new Set(rows.map(r => r.user_id))];
    let total = 0;

    for (const userId of userIds) {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, name, health_score, nps, ces, product_usage, open_tickets, churn_risk, arr, last_contact, renewal_date, stage, plan, active_playbook_id')
        .eq('user_id', userId)
        .eq('archived', false);

      if (!accounts?.length) continue;
      const count = await runOutreachForUser(userId, accounts);
      total += count;
    }

    console.log(`[outreach] tick complete — ${total} drafts queued — ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[outreach] runner error:', err.message);
  }
}

module.exports = { runOutreachRunner };
