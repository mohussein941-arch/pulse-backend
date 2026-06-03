// services/context-engine/reasoning.js — synthesise retrieved context into a response
//
// reason(context, task, opts) wraps llm.reason() and returns output + citation IDs.
// The context object is the return value of getContext().

const llm = require('../llm');

/**
 * reason — synthesise a response from retrieved context.
 *
 * @param {object} context    — return value of getContext()
 * @param {string} task       — what the model should do with the context
 *                             (e.g. 'generate_pre_meeting_brief', 'answer_question')
 * @param {object} opts
 * @param {string}  opts.orgId
 * @param {string}  opts.feature     — for ai_traces (e.g. 'pre_meeting_brief')
 * @param {string}  [opts.accountId]
 * @param {string}  [opts.createdBy]
 * @param {number}  [opts.maxTokens=1024]
 * @returns {Promise<{output: string, citationIds: string[], traceId: string|null}>}
 */
async function reason(context, task, { orgId, feature, accountId, createdBy, maxTokens = 1024 } = {}) {
  if (!orgId)   throw new Error('reason: orgId is required');
  if (!feature) throw new Error('reason: feature is required');

  const { interactions = [], citationIds = [] } = context;

  if (interactions.length === 0) {
    return {
      output:      'No relevant context found for this request.',
      citationIds: [],
      traceId:     null,
    };
  }

  // Format context blocks — each interaction gets a numbered citation
  const contextBlocks = interactions.map((i, idx) => {
    const date  = new Date(i.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const label = `[${idx + 1}] ${i.source} • ${date}${i.account_id ? ` • account ${i.account_id}` : ''}`;
    const body  = i.summary || i.content || '(no content)';
    return `${label}\n${body.slice(0, 800)}`;   // cap each block to keep total context sane
  }).join('\n\n---\n\n');

  const citationMap = interactions.map((i, idx) => `[${idx + 1}] = interaction ID ${i.id}`).join('\n');

  const { output, traceId } = await llm.reason({
    orgId,
    feature,
    accountId,
    createdBy,
    maxTokens,
    system: `You are a Customer Success expert assistant. Synthesise the retrieved interaction history into a useful response.

When referencing specific interactions, cite them using the numbered references provided (e.g. "based on the call transcript [1]").
Be factual — only use information present in the provided context. If the context is insufficient, say so clearly.
Write in plain prose. Do not use any Markdown formatting — no headings, bold, italics, bullet points, or other markup. Keep the numbered citation references like [1] exactly as instructed above.`,
    user: `Task: ${task}

Retrieved context (${interactions.length} interactions):
${contextBlocks}

Citation map:
${citationMap}`,
  });

  return { output, citationIds, traceId };
}

module.exports = { reason };
