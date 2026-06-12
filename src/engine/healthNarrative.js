'use strict';
const defaultSupabase = require('../supabase');
const { synthesizeHealth }    = require('./healthSynthesis');
const { buildAccountContext } = require('./accountContext');
const llm                     = require('../services/llm');

// M4c.3b — citations restored: semantic_context runs with the query so the assembler
// can build the citations/citationIds arrays that match the pre-migration contract.
async function generateHealthNarrative({ orgId, accountId, userId, db = defaultSupabase }) {
  const [synthesis, context] = await Promise.all([
    synthesizeHealth({ orgId, accountId, db }),
    buildAccountContext({
      orgId, accountId, userId, db,
      options: {
        sections:      ['profile', 'health_trajectory', 'voice_of_customer', 'support', 'workstreams', 'semantic_context'],
        query:         'Health, risks, sentiment, satisfaction, blockers, and renewal signals',
        semanticLimit: 8,
        maxTotalChars: 11000,
      },
    }),
  ]);

  if (!synthesis) return null;

  const task =
    `Explain this customer account's health for its CSM. ` +
    `Write 2-4 sentences in plain language: why the health is where it is, what's driving the trend, and where it's heading. ` +
    `Ground every claim in the context provided. ` +
    `Dates are pre-computed — do not perform any date arithmetic.`;

  const { output, traceId } = await llm.reason({
    orgId,
    feature:   'health_narrative',
    accountId,
    createdBy: userId,
    maxTokens: 400,
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

module.exports = { generateHealthNarrative };
