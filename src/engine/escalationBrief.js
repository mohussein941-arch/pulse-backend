'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const defaultSupabase = require('../supabase');
const { getAccountTickets } = require('../services/tickets');
const { buildAccountContext } = require('./accountContext');

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

function buildEscalationPrompt(contextText) {
  return `You are helping a Customer Success Manager frame an escalated account so a cross-functional team (Product, Tech Support, CS leadership) can rally around it quickly.

Write in plain, direct, factual language. No marketing tone, no filler, no hype. Ground every statement in the data below — do not invent facts.

## Account context
${contextText}

## Your output
Reply with RAW JSON only — no markdown, no code fences, no preamble. Schema:
{
  "situation": "2-3 sentence factual summary of where this account stands and why it's escalated",
  "challenges": ["specific blocker or risk drawn from the data", "..."],
  "recommended_actions": [{"team": "Product | Tech Support | CS | Sales", "action": "concrete next step that team should own"}]
}
Keep challenges to the 3-5 most important. Keep recommended_actions concrete and assigned to the team best placed to act.
Do NOT compute or estimate any dates or time spans yourself. Use the dates exactly as provided in the data above; never restate them as a different number of days, weeks, or months.`;
}

async function generateEscalationBrief({ orgId, accountId, userId, db = defaultSupabase }) {
  const { data: account } = await db
    .from('accounts')
    .select('id, name, stage, arr, plan, renewal_date, health_score, churn_risk, nps, ces, open_tickets, escalation_status, escalation_reason, escalation_since, escalation_notes')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!account) return null;

  const escalationQuery = account.escalation_reason || 'escalation root cause and account risk';

  const [context, tickets] = await Promise.all([
    buildAccountContext({
      orgId, accountId, userId, db,
      options: {
        sections: ['profile', 'stakeholders', 'workstreams', 'voice_of_customer', 'support', 'history', 'opportunities'],
        query: escalationQuery,
        semanticLimit: 8,
        maxTotalChars: 11000,
      },
    }),
    getAccountTickets({ orgId, accountId, db }).catch(e => {
      console.error('[escalationBrief] ticket fetch failed:', e.message);
      return { open: [], critical: [], ageing: [], counts: { open: 0, critical: 0, ageing: 0 } };
    }),
  ]);

  let ai = null;
  let traceInfo = null;
  try {
    const prompt = buildEscalationPrompt(context.text);
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
    tickets: {
      counts: tickets.counts,
      critical: tickets.critical.slice(0, 10),
    },
    ai,
    generated_at: new Date().toISOString(),
    generated_by: userId,
    model: ESCALATION_MODEL,
  };
}

module.exports = { generateEscalationBrief };
