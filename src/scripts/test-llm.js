// scripts/test-llm.js — verify classify() writes to ai_traces with correct cost
//
// Usage:
//   node src/scripts/test-llm.js <orgId>
//
// Requires ANTHROPIC_API_KEY in environment.

require('dotenv').config();

const supabase  = require('../supabase');
const llm       = require('../services/llm');

async function main() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error('Usage: node src/scripts/test-llm.js <orgId>');
    process.exit(1);
  }

  console.log('\n── Test: classify() writes ai_traces row ──');
  console.log(`  org_id: ${orgId}`);
  console.log(`  model:  ${llm.MODELS.classify}`);

  const t0 = Date.now();
  const { output, traceId } = await llm.classify({
    orgId,
    feature: 'test_classify',
    system:  'You are a classification assistant.',
    user:    'Classify this text as positive, neutral, or negative: "The onboarding went smoothly."',
    maxTokens: 10,
  });

  console.log(`  output:   "${output}"`);
  console.log(`  traceId:  ${traceId}`);
  console.log(`  latency:  ${Date.now() - t0}ms`);

  if (!traceId) {
    console.error('  FAIL — traceId is null, ai_traces write failed');
    process.exit(1);
  }

  // Verify the row in ai_traces
  const { data: trace, error } = await supabase
    .from('ai_traces')
    .select('*')
    .eq('id', traceId)
    .single();

  if (error || !trace) {
    console.error('  FAIL — could not read back the ai_traces row:', error?.message);
    process.exit(1);
  }

  const expectedCost = llm.calcCost(trace.model, trace.input_tokens, trace.output_tokens);
  const costMatch    = Math.abs(trace.cost_usd - expectedCost) < 0.000001;

  console.log('\n── ai_traces row ──');
  console.log(`  id:            ${trace.id}`);
  console.log(`  feature:       ${trace.feature}`);
  console.log(`  model:         ${trace.model}`);
  console.log(`  input_tokens:  ${trace.input_tokens}`);
  console.log(`  output_tokens: ${trace.output_tokens}`);
  console.log(`  cost_usd:      $${trace.cost_usd} (expected $${expectedCost.toFixed(8)}) ${costMatch ? '✓' : '✗ MISMATCH'}`);
  console.log(`  latency_ms:    ${trace.latency_ms}`);

  if (!costMatch) {
    console.error('  FAIL — cost_usd does not match expected value');
    process.exit(1);
  }

  console.log('\n  PASS — classify() writes ai_traces row with correct cost\n');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
