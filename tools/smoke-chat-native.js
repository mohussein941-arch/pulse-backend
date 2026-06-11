'use strict';
// tools/smoke-chat-native.js
// Exercises the native-AI chat path (buildAccountContext + llm.reason) for
// Smoke Test Co without going through HTTP or auth middleware.
//
// Usage:  node tools/smoke-chat-native.js

require('dotenv').config();

const { buildAccountContext } = require('../src/engine/accountContext');
const llm = require('../src/services/llm');

const ACCOUNT_ID = 'cd006395-c10b-4408-a01d-a631d3e5612f'; // Smoke Test Co
const ORG_ID     = '37c45065-cc6c-42bc-9d7b-a0484637a287';
const USER_ID    = 'ddad6e14-b1be-484c-b0e1-24595e573005';

function safeBlock(label, content) {
  return `<${label}>\n${content}\n</${label}>`;
}

async function runChat(question) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`QUESTION: "${question}"`);
  console.log('='.repeat(72));

  // ── context build ────────────────────────────────────────────────────────
  const context = await buildAccountContext({
    orgId:     ORG_ID,
    accountId: ACCOUNT_ID,
    userId:    USER_ID,
    options:   { query: question, semanticLimit: 8, maxTotalChars: 12000 },
  });

  console.log('\n--- STATS ---');
  console.log(JSON.stringify(context.stats, null, 2));

  if (!context.sections.profile?.available) {
    console.error('404 — account not found for this org');
    return;
  }

  // ── model call ────────────────────────────────────────────────────────────
  const { output: answer, traceId } = await llm.reason({
    orgId:     ORG_ID,
    feature:   'ask_ai_chat',
    accountId: ACCOUNT_ID,
    createdBy: USER_ID,
    system: `You are a Customer Success assistant. Answer questions about the following account based only on the data provided. If the data doesn't support a definitive answer, say so explicitly. All dates in the data are pre-computed with relative ages — no date arithmetic is needed.\n\n${safeBlock('account_data', context.text)}`,
    user: safeBlock('question', question),
    maxTokens: 500,
  });

  console.log('\n--- ANSWER ---');
  console.log(answer);

  // ── ai_traces row ─────────────────────────────────────────────────────────
  if (traceId) {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: trace } = await sb.from('ai_traces').select('feature, model, input_tokens, output_tokens, cost_usd').eq('id', traceId).single();
    console.log('\n--- AI_TRACES ROW ---');
    console.log(JSON.stringify(trace, null, 2));
  } else {
    console.log('\n[no traceId returned]');
  }
}

async function main() {
  await runChat('What did we discuss in the last meeting?');
  await runChat('Is there any upsell opportunity on this account?');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
