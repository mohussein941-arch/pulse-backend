// engine/briefGenerator.js
//
// Orchestrates pre-meeting brief generation with a 6-tuple cache key:
//   (org_id, account_id, user_id, model_id, prompt_version_hash, data_state_hash)
//
// Cache lifetime: 24 hours (set by expires_at on insert; controlled in briefs table).
// Two CSMs on the same account get distinct cached briefs (user_id in key).
// Changing BRIEF_MODEL bypasses the cache (model_id in key).
// Changing prompt text bumps BRIEF_PROMPT_VERSION → new prompt_version_hash → cache miss.
// Adding or editing any account data moves data_state_hash → cache miss.

const Anthropic = require('@anthropic-ai/sdk');

const { buildBriefPrompt, promptVersionHash, BRIEF_MODEL } = require('./briefPrompt');
const { dataStateHash }                                    = require('./dataStateHash');
const { validateBriefOutput, BriefValidationError }        = require('./briefValidator');
const defaultSupabase                                       = require('../supabase');
const { getContext }                                        = require('../services/context-engine/retrieval');

// Lazy singleton — avoids requiring ANTHROPIC_API_KEY at module load time
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// Cost per token for BRIEF_MODEL (claude-sonnet-4-6): $3/MTok in, $15/MTok out
// Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-05-23)
const COST_INPUT_PER_TOKEN  = 3  / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000;

// ── Context loader ────────────────────────────────────────────────────────────

async function loadContext({ orgId, accountId, userId, db }) {
  // Account — org ownership check is baked into the WHERE clause
  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select('id, name, health_score, churn_risk, renewal_date, stage, nps, ces, active_playbook_id, updated_at')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (accountErr || !account) return null; // caller returns 404

  // Parallel loads — none depend on each other
  const [
    { data: rawInteractions },
    { data: rawStakeholders },
    { data: rawTasks },
    { data: csmProfile },
  ] = await Promise.all([
    db.from('interactions')
      .select('id, source, content, metadata, occurred_at, updated_at')
      .eq('account_id', accountId)
      .eq('org_id', orgId)
      .order('occurred_at', { ascending: false })
      .limit(20),

    db.from('stakeholders')
      .select('id, name, role, email, updated_at')
      .eq('account_id', accountId)
      .eq('org_id', orgId),

    db.from('tasks')
      .select('id, title, priority, due_date, updated_at')
      .eq('account_id', accountId)
      .eq('org_id', orgId)
      .eq('done', false),

    db.from('csm_profile')
      .select('career_stage, specialty, working_style, updated_at')
      .eq('id', userId)
      .eq('org_id', orgId)
      .maybeSingle(),
  ]);

  // Load all active playbooks — system (org_id IS NULL) and org-specific
  const { data: rawPlaybooks } = await db
    .from('playbooks')
    .select('id, name, description')
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .eq('active', true)
    .order('id', { ascending: true });
  const playbooks = rawPlaybooks || [];

  // Lift summary out of metadata so briefPrompt formatters find it on i.summary
  const interactions = (rawInteractions || []).map(i => ({
    ...i,
    summary: i.metadata?.summary || null,
  }));

  return {
    account,
    interactions,
    stakeholders: rawStakeholders || [],
    tasks:        rawTasks        || [],
    playbooks,
    csmProfile:   csmProfile      || null,
  };
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function callClaude(promptText) {
  const t0       = Date.now();
  const response = await getAnthropic().messages.create({
    model:      BRIEF_MODEL,
    max_tokens: 1500,
    messages:   [{ role: 'user', content: promptText }],
  });
  return {
    rawText:      response.content[0].text.trim(),
    latencyMs:    Date.now() - t0,
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ── ai_traces write (best-effort) ─────────────────────────────────────────────

async function writeTrace({ orgId, accountId, userId, inputTokens, outputTokens, latencyMs, db }) {
  const costUsd = inputTokens * COST_INPUT_PER_TOKEN + outputTokens * COST_OUTPUT_PER_TOKEN;
  const { error } = await db
    .from('ai_traces')
    .insert({
      org_id:        orgId,
      feature:       'pre_meeting_brief',
      model:         BRIEF_MODEL,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_usd:      costUsd,
      latency_ms:    latencyMs,
      account_id:    accountId,
      created_by:    userId,
    });
  if (error) console.error('[briefGenerator] ai_traces write failed:', error.message);
}

// ── Parse + validate ──────────────────────────────────────────────────────────

function parseAndValidate(rawText, { stakeholderNames, playbookNames }) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new BriefValidationError(
      `Response is not valid JSON: ${rawText.slice(0, 200)}`
    );
  }
  return validateBriefOutput(parsed, { stakeholderNames, playbookNames });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) a pre-meeting brief for an account.
 *
 * @param {{ orgId, accountId, userId, supabaseClient }} opts
 * @returns {Promise<{ content: object, fromCache: boolean } | null>}
 *   null means the account was not found (caller should 404).
 *   Throws on generation failure after one retry.
 */
async function generateBrief({ orgId, accountId, userId, supabaseClient }) {
  const db = supabaseClient || defaultSupabase;

  // 1. Load context (null → account not found / wrong org)
  const context = await loadContext({ orgId, accountId, userId, db });
  if (!context) return null;

  // 2. Compute cache key components
  const pvHash = promptVersionHash();
  const dsHash = dataStateHash(context);

  // 3. Cache lookup — all 6 dimensions must match AND brief must not be expired
  const { data: cached } = await db
    .from('briefs')
    .select('content')
    .eq('org_id',              orgId)
    .eq('account_id',          accountId)
    .eq('user_id',             userId)
    .eq('model_id',            BRIEF_MODEL)
    .eq('prompt_version_hash', pvHash)
    .eq('data_state_hash',     dsHash)
    .gt('expires_at',          new Date().toISOString())
    .maybeSingle();

  if (cached) {
    return { content: cached.content, fromCache: true };
  }

  // M0.1 — replace the recency context with relevance-ranked retrieval, for the prompt only.
  // dsHash is already computed above from loadContext's deterministic set, so the cache key
  // is unaffected. getContext runs only here (cache miss), never on a cache hit.
  try {
    const retrieval = await getContext(
      `Pre-meeting context for ${context.account.name}: recent activity, open risks, blockers, sentiment, renewal status, and outstanding commitments`,
      { orgId, accountId, limit: 12, createdBy: userId }
    );
    if (retrieval?.interactions?.length) {
      context.interactions = retrieval.interactions;
    }
  } catch (err) {
    // Non-fatal: keep the recency context loadContext already provided.
    console.warn(`[brief] getContext failed, using recency context: ${err.message}`);
  }

  // 4. Build validation sets from loaded context
  const stakeholderNames = context.stakeholders.map(s => s.name);
  const playbookNames    = context.playbooks.map(p => p.name);
  const basePrompt       = buildBriefPrompt(context);

  // 5. Call Claude with exactly one retry on BriefValidationError
  let content;
  let traceInfo;

  const attempt = async (extraInstruction = '') => {
    const fullPrompt = extraInstruction
      ? `${basePrompt}\n\n${extraInstruction}`
      : basePrompt;
    const result = await callClaude(fullPrompt);
    traceInfo = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    return parseAndValidate(result.rawText, { stakeholderNames, playbookNames });
  };

  try {
    content = await attempt();
  } catch (err) {
    if (err instanceof BriefValidationError) {
      const addendum =
        `Your previous response failed validation: ${err.message}. ` +
        `Retry strictly following the schema and the fabrication rules.`;
      // Second failure propagates — caller returns 500
      content = await attempt(addendum);
    } else {
      throw err;
    }
  }

  // 6. Write ai_traces (best-effort — a trace failure must not block the response)
  if (traceInfo) {
    writeTrace({ orgId, accountId, userId, ...traceInfo, db }).catch(() => {});
  }

  // 7. Persist to briefs cache
  // Upsert on the unique constraint so concurrent requests don't double-insert
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { error: upsertErr } = await db
    .from('briefs')
    .upsert(
      {
        org_id:              orgId,
        account_id:          accountId,
        user_id:             userId,
        model_id:            BRIEF_MODEL,
        prompt_version_hash: pvHash,
        data_state_hash:     dsHash,
        content,
        expires_at:          expiresAt,
      },
      { onConflict: 'org_id,account_id,user_id,model_id,prompt_version_hash,data_state_hash' }
    );

  if (upsertErr) {
    // Log but don't fail — the caller still gets a valid brief
    console.error('[briefGenerator] briefs upsert failed:', upsertErr.message);
  }

  return { content, fromCache: false };
}

module.exports = { generateBrief };
