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
  const name    = account.name;
  const contact = ctx.contactFirstName || 'there';
  const csm     = ctx.csmName || 'Your Customer Success Manager';
  const renewal = account.renewal_date
    ? new Date(account.renewal_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'soon';

  // Build an optional context line from last human activity (not automation)
  const lastTouchLine = ctx.lastActivityNote && ctx.lastActivityDate
    ? `When we last connected (${new Date(ctx.lastActivityDate).toLocaleDateString('en-GB',{day:'numeric',month:'long'})}), ${ctx.lastActivityNote.length < 120 ? `we discussed: "${ctx.lastActivityNote}"` : 'we covered a lot of ground'}.`
    : '';

  // Build a score reference line for survey signals
  const scoreRef = ctx.lastSurveyScore !== null && ctx.lastSurveyType
    ? `Your most recent ${ctx.lastSurveyType} score was ${ctx.lastSurveyScore}.`
    : '';

  switch (triggerType) {
    case 'health_drop':
      return {
        subject: `Checking in — ${name}`,
        body:
`Hi ${contact},

I wanted to reach out because I've noticed some changes in ${name}'s metrics that I'd like to understand better.${lastTouchLine ? '\n\n'+lastTouchLine : ''}

Would you be open to a 20-minute call this week? I'd love to hear how things are going from your side and make sure we're supporting you well.

Best,
${csm}`,
      };

    case 'no_contact':
      return {
        subject: `Something worth sharing — ${name}`,
        body:
`Hi ${contact},
${lastTouchLine ? '\n'+lastTouchLine+'\n' : ''}
I've been thinking about ${name} and wanted to reach out with a couple of things that might be useful for your team right now.

Would a quick 15-minute call work this week? Happy to keep it focused and make it worth your time.

Best,
${csm}`,
      };

    case 'renewal_approaching':
      return {
        subject: `Renewal on ${renewal} — let's make a plan`,
        body:
`Hi ${contact},

${name}'s renewal is coming up on ${renewal}. Before we get into the administrative side, I'd love to take 30 minutes to do a proper review together — what's worked, what could be better, and what success looks like in the next period.${lastTouchLine ? '\n\n'+lastTouchLine : ''}

Are you available this week or next for a conversation?

Best,
${csm}`,
      };

    case 'nps_drop':
      return {
        subject: `I'd like to understand your experience better`,
        body:
`Hi ${contact},

${scoreRef ? scoreRef+' ' : ''}I take that seriously, and I don't want to let it sit without addressing it directly.

Could we find 15 minutes this week? I'd genuinely like to understand what's not landing and what we can do differently.

Best,
${csm}`,
      };

    case 'usage_drop':
      return {
        subject: `Making sure ${name} gets full value`,
        body:
`Hi ${contact},

I noticed product engagement at ${name} has been lower lately. In my experience, this usually means one of three things: the team has changed, there's a friction point we haven't addressed, or there's a feature that would genuinely help but hasn't been introduced yet.${lastTouchLine ? '\n\n'+lastTouchLine : ''}

Would a 20-minute call work? I'd come prepared with a few specific ideas.

Best,
${csm}`,
      };

    case 'playbook_suggested':
      return {
        subject: `A success plan for ${name}'s next stage`,
        body:
`Hi ${contact},

Based on where ${name} is in your journey, I think now is the right moment to get deliberate about what the next chapter looks like.${lastTouchLine ? '\n\n'+lastTouchLine : ''}

I have a structured success plan I'd like to walk you through — it takes 30 minutes and gives us a shared roadmap. Would that be useful?

Best,
${csm}`,
      };

    case 'no_champion':
      return {
        subject: `Making sure we have the right contacts at ${name}`,
        body:
`Hi ${contact},

I want to make sure I'm engaging with the right people on your team — both to get you the best support and to ensure we're aligned with whoever drives decisions around the platform.

Could we take 10 minutes to confirm the right stakeholders on your side? It helps me tailor my outreach and make sure nothing falls through the cracks.

Best,
${csm}`,
      };

    case 'early_renewal_risk':
      return {
        subject: `Getting ahead of renewal for ${name}`,
        body:
`Hi ${contact},

Your renewal is still ${account.renewal_date ? Math.ceil((new Date(account.renewal_date)-Date.now())/86400000) : 'some time'} away, but I'd rather have this conversation now than in a rush later.${lastTouchLine ? '\n\n'+lastTouchLine : ''}

I'd love to schedule a brief check-in to make sure we're on a strong trajectory together. Would 20 minutes work in the next two weeks?

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
// Note: no_champion and early_renewal_risk are injected by runOutreachForUser
// after stakeholder data is loaded, since detectSignals doesn't have that context.
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
  // Early renewal risk: health deteriorating with 60-120 days left — act now, not at 30 days
  if ((account.health_score ?? 100) < 55 && d > 60 && d <= 120)          signals.push('early_renewal_risk');
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

    // Fetch last activity note — gives the draft a specific hook to reference
    const { data: lastActivity } = await supabase
      .from('activity_log')
      .select('note, type, logged_at')
      .eq('account_id', account.id)
      .eq('user_id', userId)
      .not('source', 'eq', 'automation')
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Fetch last survey score for context in NPS/satisfaction signals
    const { data: lastSurvey } = await supabase
      .from('surveys')
      .select('type, responses')
      .eq('account_id', account.id)
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastScore = lastSurvey?.responses?.[0]?.score ?? null;

    const ctx = {
      csmName,
      contactFirstName: primary?.name?.split(' ')[0] || 'there',
      recipientEmail:   primary?.email || null,
      recipientName:    primary?.name  || null,
      lastActivityNote: lastActivity?.note || null,
      lastActivityType: lastActivity?.type || null,
      lastActivityDate: lastActivity?.logged_at || null,
      lastSurveyScore:  lastScore,
      lastSurveyType:   lastSurvey?.type || null,
      noChampion:       !stakeholders?.some(s => ['Champion','Economic Buyer'].includes(s.role)),
    };

    // Add champion risk signal if no Champion or Economic Buyer is mapped
    if (ctx.noChampion) signals.push('no_champion');

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
