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
      .select("id, org_id, user_id, nps, ces, open_tickets")
      .eq("user_id", userId);
    const { data } = await (exact ? q.eq(col, accountKey) : q.ilike(col, accountKey)).maybeSingle();
    if (data) return data;
  }
  return null;
}

// ── Shared usage write: score + health + persist. Used by the summary webhook
//    AND the daily event tally, so the math lives in exactly one place. ────────
async function writeUsageSnapshot(account, metrics) {
  const usageScore = calculateUsageScore(metrics);
  if (usageScore === null)                return { status: "skipped", reason: "no usable metrics provided" };
  if (usageScore < 0 || usageScore > 100) return { status: "skipped", reason: "calculated score out of 0-100 range" };

  const { healthScore, churnRisk, stage } = calcHealth({
    nps:          account.nps          || 50,
    ces:          account.ces          || 3.5,
    productUsage: usageScore,
    openTickets:  account.open_tickets || 0,
  });

  const now = new Date().toISOString();

  await Promise.all([
    supabase.from("accounts").update({
      product_usage:            usageScore,
      product_usage_updated_at: now,
      health_score:             healthScore,
      churn_risk:               churnRisk,
      stage,
    }).eq("id", account.id).eq("org_id", account.org_id),

    supabase.from("usage_history").insert({
      org_id:              account.org_id,            // ← fixes the NOT NULL omission that broke ingestion
      user_id:             account.user_id,
      account_id:          account.id,
      product_usage:       usageScore,
      active_users:        metrics.active_users        ?? null,
      licensed_seats:      metrics.licensed_seats      ?? null,
      dau:                 metrics.dau                 ?? null,
      mau:                 metrics.mau                 ?? null,
      wau:                 metrics.wau                 ?? null,
      features_used_count: metrics.features_used_count ?? null,
      total_features:      metrics.total_features      ?? null,
      sessions_last_30d:   metrics.sessions_last_30d   ?? null,
      last_active_at:      metrics.last_active_at      ?? null,
      events_count:        metrics.events_count        ?? null,
      key_events:          metrics.key_events          ?? null,
      raw_payload:         metrics.raw_payload         ?? null,
      recorded_at:         now,
    }),
  ]);

  return { status: "updated", product_usage: usageScore, health_score: healthScore };
}

async function processItem(userId, item) {
  const accountKey = item.account;
  if (!accountKey) return { status: "skipped", reason: "missing `account` field" };

  const account = await matchAccount(userId, accountKey);
  if (!account) return { account: accountKey, status: "not_found", reason: "no account matched by domain, name, or external_id" };

  const result = await writeUsageSnapshot(account, { ...item, raw_payload: item });
  if (result.status !== "updated") return { account: accountKey, ...result };

  return {
    account:       accountKey,
    status:        "updated",
    product_usage: result.product_usage,
    health_score:  result.health_score,
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

// ── Usage events intake — raw "receipts", appended to usage_events ────────────
async function insertUsageEvents(userId, body) {
  const events = Array.isArray(body) ? body : [body];
  const skipped = [];
  const accountCache = new Map();
  const valid = [];

  for (const e of events) {
    const accountKey = e.account;
    const eventName  = e.event || e.event_name;
    if (!accountKey) { skipped.push({ status: "skipped", reason: "missing `account`" }); continue; }
    if (!eventName)  { skipped.push({ account: accountKey, status: "skipped", reason: "missing `event`" }); continue; }

    let account = accountCache.get(accountKey);
    if (account === undefined) {
      account = await matchAccount(userId, accountKey);
      accountCache.set(accountKey, account);
    }
    if (!account) { skipped.push({ account: accountKey, status: "not_found" }); continue; }

    valid.push({
      org_id:      account.org_id,
      user_id:     userId,
      account_id:  account.id,
      user_ref:    e.user_ref ?? null,
      event_name:  eventName,
      occurred_at: e.occurred_at ? new Date(e.occurred_at).toISOString() : new Date().toISOString(),
      properties:  e.properties ?? null,
      session_id:  e.session_id ?? null,
      event_id:    e.event_id ?? null,
    });
  }

  // Dedup by event_id (one user → one org, so all valid rows share org_id).
  const seen = new Set();
  const idRows = valid.filter(r => r.event_id != null);
  if (idRows.length > 0) {
    const orgId = idRows[0].org_id;
    const ids   = [...new Set(idRows.map(r => r.event_id))];
    const { data: existing } = await supabase
      .from("usage_events").select("event_id").eq("org_id", orgId).in("event_id", ids);
    for (const r of (existing || [])) seen.add(r.event_id);
  }
  let deduped = 0;
  const toInsert = valid.filter(r => {
    if (r.event_id == null) return true;
    if (seen.has(r.event_id)) { deduped++; return false; }
    seen.add(r.event_id);
    return true;
  });

  let inserted = 0;
  if (toInsert.length > 0) {
    const { error } = await supabase.from("usage_events").insert(toInsert);
    if (error) throw error;
    inserted = toInsert.length;
  }

  return {
    inserted,
    deduped,
    not_found: skipped.filter(s => s.status === "not_found").length,
    skipped:   skipped.filter(s => s.reason).length,
  };
}

publicRouter.post("/events/:token", async (req, res) => {
  try {
    const { data: wh } = await supabase
      .from("user_webhooks").select("user_id").eq("token", req.params.token).maybeSingle();
    if (!wh) return res.status(401).json({ error: "Invalid webhook token" });

    const result = await insertUsageEvents(wh.user_id, req.body);
    res.json({ received: Array.isArray(req.body) ? req.body.length : 1, ...result });
  } catch (err) {
    console.error("[Usage Events]", err.message);
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
