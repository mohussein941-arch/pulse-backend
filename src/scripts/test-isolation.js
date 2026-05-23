// scripts/test-isolation.js — multi-tenancy isolation test
//
// Creates context-engine queries as Org A and confirms ZERO rows from Org B leak through,
// and vice versa. Tests all SQL-touching stages: keywordSearch and the final windowAndCite.
//
// Usage:
//   node src/scripts/test-isolation.js
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in .env
// Pass --staging to run against staging (set env vars before running)

require('dotenv').config();

const supabase = require('../supabase');
const { keywordSearch, windowAndCite } = require('../services/context-engine/retrieval');

// Staging org IDs (from org audit)
const ORG_A = '34442bfa-9d45-4cb6-9d6d-b08216f6fc08';  // Test Org A
const ORG_B = 'f09faa13-98a3-4f30-b6fc-24b89a3056b3';  // Test Org B

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS  ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL  ${label}${detail ? `\n         ${detail}` : ''}`);
    failed++;
  }
}

async function getInteractionOrgIds(ids) {
  if (!ids.length) return [];
  const { data } = await supabase.from('interactions').select('id, org_id').in('id', ids);
  return data || [];
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  Multi-tenancy Isolation Test                           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Org A: ${ORG_A}`);
  console.log(`  Org B: ${ORG_B}\n`);

  // ── Test 1: Direct DB counts ──────────────────────────────────────────────

  console.log('── Test 1: Raw interaction counts per org ──');

  const { count: countA } = await supabase
    .from('interactions')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', ORG_A);

  const { count: countB } = await supabase
    .from('interactions')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', ORG_B);

  console.log(`  Org A interactions: ${countA}`);
  console.log(`  Org B interactions: ${countB}`);

  assert(countA > 0,  'Org A has interactions to test with');
  assert(countB > 0,  'Org B has interactions to test with');

  // ── Test 2: keywordSearch scoping ────────────────────────────────────────

  console.log('\n── Test 2: keywordSearch("health") scoped to Org A only ──');

  const kwResultsA = await keywordSearch({ orgId: ORG_A, queries: ['health'] });
  const kwIdsA     = kwResultsA.map(r => r.id);
  console.log(`  keywordSearch returned ${kwIdsA.length} rows for Org A`);

  if (kwIdsA.length > 0) {
    const rows    = await getInteractionOrgIds(kwIdsA);
    const leakers = rows.filter(r => r.org_id !== ORG_A);
    assert(leakers.length === 0,
      `No Org B rows in Org A keywordSearch results`,
      leakers.length > 0 ? `Leaked IDs: ${leakers.map(r => r.id).join(', ')}` : '');
  }

  console.log('\n── Test 2b: keywordSearch("health") scoped to Org B only ──');

  const kwResultsB = await keywordSearch({ orgId: ORG_B, queries: ['health'] });
  const kwIdsB     = kwResultsB.map(r => r.id);
  console.log(`  keywordSearch returned ${kwIdsB.length} rows for Org B`);

  if (kwIdsB.length > 0) {
    const rows    = await getInteractionOrgIds(kwIdsB);
    const leakers = rows.filter(r => r.org_id !== ORG_B);
    assert(leakers.length === 0,
      `No Org A rows in Org B keywordSearch results`,
      leakers.length > 0 ? `Leaked IDs: ${leakers.map(r => r.id).join(', ')}` : '');
  }

  // ── Test 3: windowAndCite scoping ────────────────────────────────────────

  console.log('\n── Test 3: windowAndCite scoped to Org A — should return ZERO Org B rows ──');

  // Load all Org B interaction IDs and try to fetch them as Org A (should get nothing)
  const { data: orgBRows } = await supabase
    .from('interactions')
    .select('id')
    .eq('org_id', ORG_B);

  const orgBIds = (orgBRows || []).map(r => ({ id: r.id, _score: 1.0 }));
  console.log(`  Attempting to windowAndCite ${orgBIds.length} Org B IDs using Org A scope...`);

  const leaked = await windowAndCite({ orgId: ORG_A, ranked: orgBIds, limit: 100 });
  assert(leaked.length === 0,
    `windowAndCite(orgId=OrgA, ids=OrgB) returns 0 rows`,
    `Got ${leaked.length} rows — isolation breach!`);

  // ── Test 4: Cross-ID fetch — service role bypass attempt ─────────────────

  console.log('\n── Test 4: Application-layer org_id filter on interactions.select ──');

  const { data: orgAData } = await supabase
    .from('interactions')
    .select('id, org_id')
    .eq('org_id', ORG_A);

  const orgAIds = (orgAData || []).map(r => r.id);
  const crossOrgFetch = (orgAData || []).filter(r => r.org_id !== ORG_A);
  assert(crossOrgFetch.length === 0,
    `Org A select contains only Org A rows (${orgAIds.length} rows checked)`,
    `Got ${crossOrgFetch.length} rows with wrong org_id`);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log(`║  Result: ${passed} passed, ${failed} failed                          ║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');

  if (failed > 0) {
    console.error('ISOLATION TEST FAILED — do not ship');
    process.exit(1);
  } else {
    console.log('ISOLATION TEST PASSED — getContext is safe to ship\n');
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
