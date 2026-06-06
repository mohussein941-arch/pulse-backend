const Anthropic = require('@anthropic-ai/sdk');
const defaultSupabase = require('../supabase');

const ESCALATION_MODEL = 'claude-sonnet-4-6';
const COST_INPUT_PER_TOKEN = 3 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

async function callClaude(promptText) {
  const t0 = Date.now();
  const response = await getAnthropic().messages.create({
    model: ESCALATION_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: promptText }],
  });
  return {
    rawText: response.content[0].text.trim(),
    latencyMs: Date.now() - t0,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function writeTrace({ orgId, accountId, userId, inputTokens, outputTokens, latencyMs, db }) {
  try {
    const costUsd = inputTokens * COST_INPUT_PER_TOKEN + outputTokens * COST_OUTPUT_PER_TOKEN;
    await db.from('ai_traces').insert({
      org_id: orgId, feature: 'escalation_brief', model: ESCALATION_MODEL,
      input_tokens: inputTokens, output_tokens: outputTokens,
      cost_usd: costUsd, latency_ms: latencyMs,
      account_id: accountId || null, created_by: userId || null,
    });
  } catch (e) { /* best-effort trace */ }
}

function buildEscalationPrompt({ account, recentMeetings, openTasks, stakeholders }) {
  const meetingsText = recentMeetings.length
    ? recentMeetings.map((m, i) =>
        `Meeting ${i + 1} — ${m.title || 'Untitled'} (${m.date || 'no date'})\nSummary: ${m.summary || 'none'}\nAction items: ${m.action_items || 'none'}`
      ).join('\n\n')
    : 'No recent meetings on record.';
  const tasksText = openTasks.length
    ? openTasks.map(t => `- [${t.priority || 'normal'}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n')
    : 'No open tasks.';
  const stakeText = stakeholders.length
    ? stakeholders.map(s => `- ${s.name}${s.title ? `, ${s.title}` : ''}${s.sentiment ? ` — sentiment: ${s.sentiment}` : ''}`).join('\n')
    : 'No stakeholders on record.';

  return `You are helping a Customer Success Manager frame an escalated account so a cross-functional team (Product, Tech Support, CS leadership) can rally around it quickly.

Write in plain, direct, factual language. No marketing tone, no filler, no hype. Ground every statement in the data below — do not invent facts.

## Account
Name: ${account.name}
Stage: ${account.stage ?? 'unknown'}
ARR: ${account.arr ?? 'unknown'}
Health score: ${account.health_score ?? 'unknown'}
Churn risk: ${account.churn_risk ?? 'unknown'}
NPS: ${account.nps ?? 'none'}
CES: ${account.ces ?? 'none'}
Open tickets: ${account.open_tickets ?? 0}
Renewal: ${account.renewal_date ?? 'none on record'}

## Why it's escalated
Reason: ${account.escalation_reason || 'not specified'}
CSM notes: ${account.escalation_notes || 'none'}
Escalated since: ${account.escalation_since || 'unknown'}

## Recent meetings
${meetingsText}

## Open tasks
${tasksText}

## Stakeholders
${stakeText}

## Your output
Reply with RAW JSON only — no markdown, no code fences, no preamble. Schema:
{
  "situation": "2-3 sentence factual summary of where this account stands and why it's escalated",
  "challenges": ["specific blocker or risk drawn from the data", "..."],
  "recommended_actions": [{"team": "Product | Tech Support | CS | Sales", "action": "concrete next step that team should own"}]
}
Keep challenges to the 3-5 most important. Keep recommended_actions concrete and assigned to the team best placed to act.`;
}

async function generateEscalationBrief({ orgId, accountId, userId, db = defaultSupabase }) {
  const { data: account } = await db
    .from('accounts')
    .select('id, name, stage, arr, plan, renewal_date, health_score, churn_risk, nps, ces, open_tickets, escalation_status, escalation_reason, escalation_since, escalation_notes')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!account) return null;

  const { data: meetings } = await db
    .from('meeting_notes')
    .select('title, meeting_date, summary, action_items')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .order('meeting_date', { ascending: false })
    .limit(3);

  const { data: openTasks } = await db
    .from('tasks')
    .select('title, priority, due_date')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .eq('done', false)
    .order('due_date', { ascending: true });

  const { data: stakeholders } = await db
    .from('stakeholders')
    .select('name, title, role, sentiment')
    .eq('account_id', accountId)
    .eq('org_id', orgId);

  const recentMeetings = (meetings || []).map(m => ({
    date: m.meeting_date, title: m.title, summary: m.summary, action_items: m.action_items,
  }));

  let ai = null;
  let traceInfo = null;
  try {
    const prompt = buildEscalationPrompt({ account, recentMeetings, openTasks: openTasks || [], stakeholders: stakeholders || [] });
    const result = await callClaude(prompt);
    traceInfo = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    const parsed = JSON.parse(result.rawText);
    ai = {
      situation: typeof parsed.situation === 'string' ? parsed.situation : null,
      challenges: Array.isArray(parsed.challenges) ? parsed.challenges.filter(c => typeof c === 'string') : [],
      recommended_actions: Array.isArray(parsed.recommended_actions)
        ? parsed.recommended_actions
            .filter(a => a && typeof a.action === 'string')
            .map(a => ({ team: typeof a.team === 'string' ? a.team : 'Team', action: a.action }))
        : [],
    };
  } catch (e) {
    console.error('[escalationBrief] AI framing failed:', e.message);
    ai = null;
  }

  if (traceInfo) {
    writeTrace({ orgId, accountId, userId, ...traceInfo, db }).catch(() => {});
  }

  return {
    account: {
      name: account.name, stage: account.stage, arr: account.arr, plan: account.plan,
      renewal_date: account.renewal_date, health_score: account.health_score,
      churn_risk: account.churn_risk, nps: account.nps, ces: account.ces,
      open_tickets: account.open_tickets,
    },
    escalation: {
      status: account.escalation_status, reason: account.escalation_reason || '',
      since: account.escalation_since, notes: account.escalation_notes || '',
    },
    recent_meetings: recentMeetings,
    open_tasks: openTasks || [],
    stakeholders: stakeholders || [],
    ai,
    generated_at: new Date().toISOString(),
    generated_by: userId,
    model: ESCALATION_MODEL,
  };
}

module.exports = { generateEscalationBrief };
