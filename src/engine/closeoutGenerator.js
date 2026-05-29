// engine/closeoutGenerator.js
//
// Orchestrates post-meeting closeout generation.
// Cache key: (org_id, meeting_notes_id) — simpler than the 6-tuple used by
// briefGenerator because a meeting's content is fixed after it happens.
// Cache hit requires: row existence AND prompt_version equality (D7 rule).
// No TTL, no model equality check, no data hash.

const Anthropic = require('@anthropic-ai/sdk');

const { buildCloseoutPrompt, CLOSEOUT_MODEL, CLOSEOUT_PROMPT_VERSION } = require('./closeoutPrompt');
const { validateCloseoutOutput, CloseoutValidationError }               = require('./closeoutValidator');
const { getContext }                                                     = require('../services/context-engine/retrieval');
const defaultSupabase                                                    = require('../supabase');

// Lazy singleton — avoids requiring ANTHROPIC_API_KEY at module load time
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// Cost per token for CLOSEOUT_MODEL (claude-sonnet-4-6): $3/MTok in, $15/MTok out
// Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-05-23)
const COST_INPUT_PER_TOKEN  = 3  / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000;

// ── Base context loader ───────────────────────────────────────────────────────
// Mirrors M2's loadContext minus the interactions query. Interactions come from
// getContext (semantic retrieval) in step 5 of generateCloseout.
// Intentional duplication — no cross-engine imports during M3 (see TECH_DEBT.md).

async function loadBaseContext({ orgId, accountId, userId, db }) {
  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select('id, name, health_score, churn_risk, renewal_date, stage, nps, ces, active_playbook_id, updated_at')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (accountErr || !account) return null;

  const [
    { data: rawStakeholders },
    { data: rawTasks },
    { data: csmProfile },
  ] = await Promise.all([
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

  const { data: rawPlaybooks } = await db
    .from('playbooks')
    .select('id, name, description')
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .eq('active', true)
    .order('id', { ascending: true });

  return {
    account,
    stakeholders: rawStakeholders || [],
    tasks:        rawTasks        || [],
    playbooks:    rawPlaybooks    || [],
    csmProfile:   csmProfile      || null,
  };
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function callClaude(promptText) {
  const t0       = Date.now();
  const response = await getAnthropic().messages.create({
    model:      CLOSEOUT_MODEL,
    max_tokens: 2000,
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
      feature:       'post_meeting_closeout',
      model:         CLOSEOUT_MODEL,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_usd:      costUsd,
      latency_ms:    latencyMs,
      account_id:    accountId,
      created_by:    userId,
    });
  if (error) console.error('[closeoutGenerator] ai_traces write failed:', error.message);
}

// ── Parse + validate ──────────────────────────────────────────────────────────

function parseAndValidate(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CloseoutValidationError(
      `Response is not valid JSON: ${rawText.slice(0, 200)}`
    );
  }
  return validateCloseoutOutput(parsed);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) a post-meeting closeout for a meeting.
 *
 * @param {{ orgId, meetingNotesId, userId, supabaseClient }} opts
 * @returns {Promise<{ content: object, fromCache: boolean } | null>}
 *   null means the meeting_notes row was not found (caller should 404).
 *   Throws on unlinked meeting, missing transcript, or generation failure.
 */
async function generateCloseout({ orgId, meetingNotesId, userId, supabaseClient }) {
  const db = supabaseClient || defaultSupabase;

  // 1. Cache check — before loading anything else.
  //    Hit requires both row existence AND prompt_version equality (D7).
  const { data: cachedRow } = await db
    .from('closeouts')
    .select('content, prompt_version')
    .eq('org_id', orgId)
    .eq('meeting_notes_id', meetingNotesId)
    .maybeSingle();

  if (cachedRow && cachedRow.prompt_version === CLOSEOUT_PROMPT_VERSION) {
    return { content: cachedRow.content, fromCache: true };
  }

  // 2. Load meeting_notes row by id + org_id.
  const { data: meetingRow, error: meetingErr } = await db
    .from('meeting_notes')
    .select('id, fireflies_id, account_id, summary, meeting_date, title')
    .eq('id', meetingNotesId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (meetingErr || !meetingRow) return null;

  if (!meetingRow.account_id) {
    throw new Error(
      'Meeting must be linked to an account before generating a closeout.'
    );
  }

  // 3. Load transcript interaction.
  //    Full transcript text lives in the interactions table (source = call_transcript),
  //    linked to the meeting via metadata.fireflies_id.
  const { data: transcriptInteraction, error: transcriptErr } = await db
    .from('interactions')
    .select('id, content, occurred_at')
    .eq('org_id', orgId)
    .eq('source', 'call_transcript')
    .contains('metadata', { fireflies_id: meetingRow.fireflies_id })
    .limit(1)
    .maybeSingle();

  if (transcriptErr || !transcriptInteraction || !transcriptInteraction.content) {
    throw new Error(
      'No transcript found for this meeting. Cannot generate closeout.'
    );
  }

  // 4. Load base account context (account, stakeholders, tasks, playbooks, csmProfile).
  const baseContext = await loadBaseContext({
    orgId,
    accountId: meetingRow.account_id,
    userId,
    db,
  });

  if (!baseContext) {
    throw new Error(
      'Account data could not be loaded. The account may have been deleted.'
    );
  }

  // 5. Semantic-retrieve related interactions via getContext.
  //    Query = meeting summary. Skip entirely if summary is absent.
  let retrieved = [];
  const querySummary = (meetingRow.summary || '').trim();
  if (querySummary) {
    const result = await getContext(querySummary, {
      orgId,
      accountId:  meetingRow.account_id,
      limit:      6,
      createdBy:  userId,
    });
    retrieved = result.interactions || [];
  }

  // 6. Remove the current transcript from retrieved list; slice to 5.
  //    Map to the shape briefGenerator's loadContext produces so
  //    closeoutPrompt's formatInteractions works without modification.
  const interactions = retrieved
    .filter(i => i.id !== transcriptInteraction.id)
    .slice(0, 5)
    .map(i => ({
      ...i,
      summary: i.summary ?? i.metadata?.summary ?? null,
    }));

  // 7–8. Build prompt.
  const basePrompt = buildCloseoutPrompt({
    account:      baseContext.account,
    transcript:   transcriptInteraction.content,
    interactions,
    stakeholders: baseContext.stakeholders,
    tasks:        baseContext.tasks,
    playbooks:    baseContext.playbooks,
    csmProfile:   baseContext.csmProfile,
  });

  // 9–10. Call Claude with exactly one retry on CloseoutValidationError.
  let content;
  let traceInfo;

  const attempt = async (extraInstruction = '') => {
    const fullPrompt = extraInstruction
      ? `${basePrompt}\n\n${extraInstruction}`
      : basePrompt;
    const result = await callClaude(fullPrompt);
    traceInfo = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    return parseAndValidate(result.rawText);
  };

  try {
    content = await attempt();
  } catch (err) {
    if (err instanceof CloseoutValidationError) {
      const addendum =
        `Your previous response failed validation: ${err.message}. ` +
        `Retry strictly following the schema and the fabrication rules.`;
      // Second failure propagates — caller returns 500
      content = await attempt(addendum);
    } else {
      throw err;
    }
  }

  // 11. Upsert into closeouts.
  //     onConflict = 'org_id,meeting_notes_id' overwrites the existing row,
  //     which is the correct behaviour when prompt_version differed in step 1.
  const { error: upsertErr } = await db
    .from('closeouts')
    .upsert(
      {
        org_id:           orgId,
        meeting_notes_id: meetingNotesId,
        account_id:       meetingRow.account_id,
        user_id:          userId,
        content,
        model:            CLOSEOUT_MODEL,
        prompt_version:   CLOSEOUT_PROMPT_VERSION,
      },
      { onConflict: 'org_id,meeting_notes_id' }
    );

  if (upsertErr) {
    // Log but don't fail — the caller still gets a valid closeout
    console.error('[closeoutGenerator] closeouts upsert failed:', upsertErr.message);
  }

  // 12. Write ai_traces (best-effort — a trace failure must not block the response)
  if (traceInfo) {
    writeTrace({
      orgId,
      accountId: meetingRow.account_id,
      userId,
      ...traceInfo,
      db,
    }).catch(() => {});
  }

  // 13. Return
  return { content, fromCache: false };
}

module.exports = { generateCloseout };
