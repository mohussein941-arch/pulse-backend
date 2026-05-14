const express  = require("express");
const crypto   = require("crypto");
const supabase = require("../supabase");
const { calcHealth } = require("../health");

/**
 * Calculates a 0-100 product usage score from raw metrics.
 *
 * Priority:
 *   1. Seat adoption  (active_users / licensed_seats)  — weight 2
 *   2. Engagement     (dau / mau)                       — weight 2
 *   3. Feature breadth (features_used_count / total_features) — weight 1
 *   4. Direct score   (product_usage 0-100)             — fallback only
 *
 * Using a weighted average means partial data still produces a meaningful
 * score rather than silently falling back to the caller's number.
 */
function calculateUsageScore(m) {
  const scores = [];

  if (m.active_users != null && m.licensed_seats > 0) {
    scores.push({ score: Math.min(100, (m.active_users / m.licensed_seats) * 100), weight: 2 });
  }
  if (m.dau != null && m.mau > 0) {
    scores.push({ score: Math.min(100, (m.dau / m.mau) * 100), weight: 2 });
  }
  if (m.features_used_count != null && m.total_features > 0) {
    scores.push({ score: Math.min(100, (m.features_used_count / m.total_features) * 100), weight: 1 });
  }

  if (scores.length === 0) {
    if (m.product_usage != null) return Math.min(100, Math.max(0, parseFloat(m.product_usage)));
    return null;
  }

  const totalWeight = scores.reduce((a, b) => a + b.weight, 0);
  return Math.round(scores.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight);
}

async function matchAccount(userId, accountKey) {
  // Match order: domain → name (case-insensitive) → external_id
  for (const [col, exact] of [["domain", false], ["name", false], ["external_id", true]]) {
    const q = supabase
      .from("accounts")
      .select("id, nps, ces, open_tickets")
      .eq("user_id", userId);
    const { data } = await (exact ? q.eq(col, accountKey) : q.ilike(col, accountKey)).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function processItem(userId, item) {
  const accountKey = item.account;
  if (!accountKey) return { status: "skipped", reason: "missing `account` field" };

  const usageScore = calculateUsageScore(item);
  if (usageScore === null) return { account: accountKey, status: "skipped", reason: "no usable metrics provided" };
  if (usageScore < 0 || usageScore > 100) return { account: accountKey, status: "skipped", reason: "calculated score out of 0-100 range" };

  const account = await matchAccount(userId, accountKey);
  if (!account) return { account: accountKey, status: "not_found", reason: "no account matched by domain, name, or external_id" };

  // Recalculate full health score with updated product_usage
  const { healthScore, churnRisk, stage } = calcHealth({
    nps:          account.nps          || 50,
    ces:          account.ces          || 3.5,
    productUsage: usageScore,
    openTickets:  account.open_tickets || 0,
  });

  const now = new Date().toISOString();

  await Promise.all([
    // Update the account
    supabase.from("accounts").update({
      product_usage:            usageScore,
      product_usage_updated_at: now,
      health_score:             healthScore,
      churn_risk:               churnRisk,
      stage,
    }).eq("id", account.id).eq("user_id", userId),

    // Append to history — every call is a new data point
    supabase.from("usage_history").insert({
      user_id:             userId,
      account_id:          account.id,
      product_usage:       usageScore,
      active_users:        item.active_users        ?? null,
      licensed_seats:      item.licensed_seats      ?? null,
      dau:                 item.dau                 ?? null,
      mau:                 item.mau                 ?? null,
      features_used_count: item.features_used_count ?? null,
      total_features:      item.total_features      ?? null,
      sessions_last_30d:   item.sessions_last_30d   ?? null,
      raw_payload:         item,
      recorded_at:         now,
    }),
  ]);

  return {
    account:       accountKey,
    status:        "updated",
    product_usage: usageScore,
    health_score:  healthScore,
    breakdown: {
      seat_adoption:   item.active_users != null && item.licensed_seats > 0
        ? `${Math.round((item.active_users / item.licensed_seats) * 100)}%` : null,
      dau_mau_ratio:   item.dau != null && item.mau > 0
        ? `${Math.round((item.dau / item.mau) * 100)}%` : null,
      feature_breadth: item.features_used_count != null && item.total_features > 0
        ? `${Math.round((item.features_used_count / item.total_features) * 100)}%` : null,
    },
  };
}

// ── Public router — mounted at /webhook ──────────────────────────────────────
const publicRouter = express.Router();

publicRouter.post("/:token", async (req, res) => {
  try {
    const { data: wh } = await supabase
      .from("user_webhooks").select("user_id").eq("token", req.params.token).maybeSingle();

    if (!wh) return res.status(401).json({ error: "Invalid webhook token" });

    const items   = Array.isArray(req.body) ? req.body : [req.body];
    const results = await Promise.all(items.map(item => processItem(wh.user_id, item)));

    const updated  = results.filter(r => r.status === "updated").length;
    const notFound = results.filter(r => r.status === "not_found").length;
    const skipped  = results.filter(r => r.status === "skipped").length;

    res.json({ received: items.length, updated, not_found: notFound, skipped, results });
  } catch (err) {
    console.error("[Webhook]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Protected router — mounted at /api/webhook ───────────────────────────────
const apiRouter = express.Router();

// GET /api/webhook/token — get existing token or create one
apiRouter.get("/token", async (req, res, next) => {
  try {
    let { data, error } = await supabase
      .from("user_webhooks").select("token, created_at")
      .eq("user_id", req.userId).maybeSingle();

    if (error) throw error;

    if (!data) {
      const token = crypto.randomBytes(32).toString("hex");
      const ins   = await supabase.from("user_webhooks")
        .insert({ user_id: req.userId, token }).select("token, created_at").single();
      if (ins.error) throw ins.error;
      data = ins.data;
    }

    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/webhook/token/regenerate — issue a new token, old one stops working immediately
apiRouter.post("/token/regenerate", async (req, res, next) => {
  try {
    const token = crypto.randomBytes(32).toString("hex");
    const { data, error } = await supabase
      .from("user_webhooks")
      .upsert({ user_id: req.userId, token, created_at: new Date().toISOString() }, { onConflict: "user_id" })
      .select("token, created_at").single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = { publicRouter, apiRouter };
