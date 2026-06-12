'use strict';
const defaultSupabase = require('../supabase');
const { synthesizeHealth }    = require('./healthSynthesis');
const { buildAccountContext } = require('./accountContext');
const llm                     = require('../services/llm');

// M4c.3b — citations restored: semantic_context runs with the query so the assembler
// can build the citations/citationIds arrays that match the pre-migration contract.
async function generateCatchUp({ orgId, accountId, userId, db = defaultSupabase }) {
  const [synthesis, context] = await Promise.all([
    synthesizeHealth({ orgId, accountId, db }),
    buildAccountContext({
      orgId, accountId, userId, db,
      options: {
        sections:      ['profile', 'workstreams', 'onboarding', 'health_trajectory', 'voice_of_customer', 'support', 'history', 'semantic_context'],
        query:         'Full relationship history: meetings, emails, calls, decisions, commitments, issues, blockers, and recent activity',
        semanticLimit: 10,
        maxTotalChars: 13000,
      },
    }),
  ]);

  if (!synthesis) return null;

  const task =
    `Catch the CSM up on this account so they can walk into any conversation prepared. ` +
    `Cover, as a clear narrative: who they are and the relationship arc, what has happened recently, ` +
    `any open threads or commitments, and the current risks or opportunities. ` +
    `Keep it tight — one or two short paragraphs — and cite the interactions you draw from. ` +
    `Dates are pre-computed — do not perform any date arithmetic.`;

  const { output, traceId } = await llm.reason({
    orgId,
    feature:   'catch_up',
    accountId,
    createdBy: userId,
    maxTokens: 700,
    system:
      `You are a Customer Success expert assistant. Synthesise account context into a useful response.\n` +
      `Be factual — only use information present in the provided context. If the context is insufficient, say so clearly.\n` +
      `Write in plain prose. Do not use any Markdown formatting — no headings, bold, italics, or bullet points.\n` +
      `Items in SEMANTIC CONTEXT are numbered. When a claim is directly supported by a numbered item, append its [n] marker.`,
    user: `Task: ${task}\n\nAccount context:\n${context.text}`,
  });

  return {
    narrative:    output,
    citation_ids: context.citationIds,
    trace_id:     traceId,
    citations:    context.citations,
    synthesis,
  };
}

module.exports = { generateCatchUp };
