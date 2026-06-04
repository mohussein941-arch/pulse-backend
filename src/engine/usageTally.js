const supabase = require("../supabase");
const { computeUsageMetrics, writeUsageSnapshot } = require("../services/usage");

async function runUsageTally(asOf = new Date()) {
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id, org_id, user_id, nps, ces, open_tickets, licensed_seats, licensed_features, archived");
  if (error) { console.error("[usage-tally] account fetch failed:", error.message); throw error; }

  let updated = 0, skipped = 0, failed = 0;
  for (const account of (accounts || [])) {
    if (account.archived) { skipped++; continue; }
    try {
      const metrics = await computeUsageMetrics(account, asOf);
      const result  = await writeUsageSnapshot(account, metrics);
      if (result.status === "updated") updated++; else skipped++;
    } catch (e) {
      failed++;
      console.error(`[usage-tally] account ${account.id}: ${e.message}`);
    }
  }
  console.log(`[usage-tally] ${updated} updated, ${skipped} skipped, ${failed} failed (of ${accounts ? accounts.length : 0} accounts)`);
  return { updated, skipped, failed, total: accounts ? accounts.length : 0 };
}

module.exports = { runUsageTally };
