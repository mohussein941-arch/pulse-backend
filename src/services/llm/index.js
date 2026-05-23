// services/llm/index.js — Context Engine LLM provider abstraction
//
// Three methods: classify(), reason(), embed()
// Every call writes one row to ai_traces (cost discipline from day one).
// Uses server-side keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) — NOT per-user BYOK.

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');
const supabase  = require('../../supabase');

const MODELS = {
  classify: 'claude-haiku-4-5-20251001',
  reason:   'claude-sonnet-4-6',
  embed:    'text-embedding-3-small',
};

// USD per token (input / output).
// Source: https://platform.claude.com/docs/en/about-claude/pricing (verified 2026-05-23)
//         text-embedding-3-small: $0.020/MTok — OpenAI pricing (unchanged since Jan 2024)
// NOTE: $0.80/$4.00 was Haiku 3.5 (retired). Haiku 4.5 is $1.00/$5.00.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00 / 1_000_000, output: 5.00 / 1_000_000 },
  'claude-sonnet-4-6':         { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  'text-embedding-3-small':    { input: 0.020 / 1_000_000, output: 0 },
};

// Per-feature cost budgets in USD (for cost discipline validation in tests)
const FEATURE_BUDGETS = {
  context_retrieval:     0.01,
  generate_embedding:    0.001,
  briefing_summary:      0.02,
  pre_meeting_brief:     0.03,
  post_meeting_closeout: 0.05,
  health_narrative:      0.02,
  default:               0.05,
};

let _anthropic = null;
let _openai    = null;

function getAnthropic() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

function calcCost(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return 0;
  return p.input * inputTokens + p.output * (outputTokens || 0);
}

async function writeTrace({ orgId, feature, model, inputTokens, outputTokens, costUsd, latencyMs, accountId, interactionId, createdBy }) {
  const { data, error } = await supabase
    .from('ai_traces')
    .insert({
      org_id:         orgId,
      feature,
      model,
      input_tokens:   inputTokens,
      output_tokens:  outputTokens,
      cost_usd:       costUsd,
      latency_ms:     latencyMs,
      account_id:     accountId   || null,
      interaction_id: interactionId || null,
      created_by:     createdBy   || null,
    })
    .select('id')
    .single();

  if (error) console.error('[llm] ai_traces write failed:', error.message);
  return data?.id || null;
}

/**
 * classify — cheap Claude Haiku call for classification tasks
 * (sentiment, language, entity tagging, query expansion, etc.)
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.feature  — maps to ai_traces.feature
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {number} [opts.maxTokens=256]
 * @param {string} [opts.accountId]
 * @param {string} [opts.interactionId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<{output: string, traceId: string|null}>}
 */
async function classify({ orgId, feature, system, user, maxTokens = 256, accountId, interactionId, createdBy }) {
  const model = MODELS.classify;
  const t0    = Date.now();

  const response = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const latencyMs    = Date.now() - t0;
  const inputTokens  = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd      = calcCost(model, inputTokens, outputTokens);

  const traceId = await writeTrace({ orgId, feature, model, inputTokens, outputTokens, costUsd, latencyMs, accountId, interactionId, createdBy });

  return { output: response.content[0].text, traceId };
}

/**
 * reason — higher-capacity Claude Sonnet call for synthesis tasks
 *
 * @param {object} opts  — same shape as classify(), higher default maxTokens
 * @returns {Promise<{output: string, traceId: string|null}>}
 */
async function reason({ orgId, feature, system, user, maxTokens = 1024, accountId, interactionId, createdBy }) {
  const model = MODELS.reason;
  const t0    = Date.now();

  const response = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const latencyMs    = Date.now() - t0;
  const inputTokens  = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd      = calcCost(model, inputTokens, outputTokens);

  const traceId = await writeTrace({ orgId, feature, model, inputTokens, outputTokens, costUsd, latencyMs, accountId, interactionId, createdBy });

  return { output: response.content[0].text, traceId };
}

/**
 * embed — OpenAI text-embedding-3-small (1536d vector)
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.feature
 * @param {string} opts.text     — content to embed (caller handles chunking)
 * @param {string} [opts.accountId]
 * @param {string} [opts.interactionId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<{embedding: number[], traceId: string|null}>}
 */
async function embed({ orgId, feature, text, accountId, interactionId, createdBy }) {
  const model = MODELS.embed;
  const t0    = Date.now();

  const response = await getOpenAI().embeddings.create({
    model,
    input: text,
  });

  const latencyMs   = Date.now() - t0;
  const inputTokens = response.usage.prompt_tokens;
  const costUsd     = calcCost(model, inputTokens, 0);

  const traceId = await writeTrace({ orgId, feature, model, inputTokens, outputTokens: 0, costUsd, latencyMs, accountId, interactionId, createdBy });

  return { embedding: response.data[0].embedding, traceId };
}

module.exports = { classify, reason, embed, MODELS, PRICING, FEATURE_BUDGETS, calcCost };
