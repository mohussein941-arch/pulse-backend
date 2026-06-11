'use strict';
// tools/chat-context-smoke.js
// Simulates the POST /api/ai/chat/:accountId context-build step
// for Smoke Test Co without invoking the BYOK model.
//
// Usage:  node tools/chat-context-smoke.js

require('dotenv').config();

const { buildAccountContext } = require('../src/engine/accountContext');

const ACCOUNT_ID = 'cd006395-c10b-4408-a01d-a631d3e5612f'; // Smoke Test Co
const ORG_ID     = '37c45065-cc6c-42bc-9d7b-a0484637a287';
const USER_ID    = 'ddad6e14-b1be-484c-b0e1-24595e573005';
const QUERY      = 'what did we discuss in the last meeting?';

async function main() {
  console.log('Building account context for Smoke Test Co…\n');

  const context = await buildAccountContext({
    orgId:     ORG_ID,
    accountId: ACCOUNT_ID,
    userId:    USER_ID,
    options:   { query: QUERY, semanticLimit: 8, maxTotalChars: 12000 },
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  console.log('=== STATS ===');
  console.log(JSON.stringify(context.stats, null, 2));

  // ── Section availability summary ─────────────────────────────────────────
  console.log('\n=== SECTION AVAILABILITY ===');
  for (const [name, meta] of Object.entries(context.sections)) {
    const status   = meta.available ? 'ok' : 'unavailable';
    const truncStr = meta.truncated ? ' [truncated]' : '';
    console.log(`  ${name.padEnd(20)} ${status}${truncStr}  (${meta.text.length} chars)`);
  }

  // ── SEMANTIC CONTEXT section ──────────────────────────────────────────────
  const semText = context.sections.semantic_context?.text;
  console.log('\n=== SEMANTIC CONTEXT ===');
  console.log(semText || '(section not present or empty)');

  // ── VOICE OF CUSTOMER section ─────────────────────────────────────────────
  const vocText = context.sections.voice_of_customer?.text;
  console.log('\n=== VOICE OF CUSTOMER ===');
  console.log(vocText || '(section not present or empty)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
