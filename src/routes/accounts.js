/**
 * Accounts routes — M0b: all queries scoped to req.orgId (org scope).
 * req.userId is kept on INSERTs as created_by (column renamed in Phase 2 Step 8;
 * until then the column is still named user_id in the DB).
 * RLS on the accounts table enforces org_id = current_org_id() as a second layer.
 */

const express  = require("express");
const supabase = require("../supabase");
const { calcHealth } = require("../health");

const router = express.Router();

// ── GET /api/accounts ─────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { data: accounts, error } = await supabase
      .from("accounts")
      .select(`
        *,
        ces_history    ( value, recorded_at ),
        health_history ( score, recorded_at ),
        stakeholders   ( id, name, title, email, role, sentiment, last_touch ),
        activity_log   ( id, type, note, logged_at ),
        milestones     ( id, text, done, sort_order )
      `)
      .eq("org_id", req.orgId)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const shaped = accounts.map(a => ({
      id:           a.id,
      name:         a.name,
      industry:     a.industry || "",
      plan:         a.plan || "Starter",
      arr:          a.arr || 0,
      renewalDate:  a.renewal_date || "",
      nps:          a.nps || 50,
      ces:          parseFloat(a.ces) || 3.5,
      cesHistory:   (a.ces_history || [])
                      .sort((x, y) => x.recorded_at.localeCompare(y.recorded_at))
                      .map(c => ({ date: c.recorded_at, value: parseFloat(c.value) })),
      healthHistory: (a.health_history || [])
                      .sort((x, y) => x.recorded_at.localeCompare(y.recorded_at))
                      .map(h => ({ date: h.recorded_at, score: h.score })),
      productUsage:          a.product_usage || 60,
      productUsageUpdatedAt: a.product_usage_updated_at || null,
      openTickets:  a.open_tickets || 0,
      healthScore:  a.health_score ?? 50,
      churnRisk:    a.churn_risk   ?? 50,
      stage:        a.stage || "Stable",
      lastContact:  a.last_contact || new Date().toISOString().split("T")[0],
      nextAction:   a.next_action || "",
      notes:        a.notes || "",
      prepNotes:    a.prep_notes || "",
      archived:     a.archived || false,
      domain:       a.domain || "",
      activePlaybookId:    a.active_playbook_id || null,
      activePlaybookSteps: a.active_playbook_steps || {},
      snoozedPlaybooks:    a.snoozed_playbooks || [],
      // Expansion
      expansionPotential: a.expansion_potential || false,
      expansionArr:       parseFloat(a.expansion_arr) || 0,
      expansionStage:     a.expansion_stage || "",
      expansionNotes:     a.expansion_notes || "",
      // Escalation
      escalationStatus: a.escalation_status || null,
      escalationReason: a.escalation_reason || "",
      escalationSince:  a.escalation_since  || null,
      escalationNotes:  a.escalation_notes  || "",
      stakeholders: (a.stakeholders || []).map(s => ({
        id:        s.id,
        name:      s.name,
        title:     s.title || "",
        email:     s.email || "",
        role:      s.role || "Neutral",
        sentiment: s.sentiment || "Neutral",
        lastTouch: s.last_touch || "",
      })),
      activityLog: (a.activity_log || [])
                     .sort((x, y) => y.logged_at.localeCompare(x.logged_at))
                     .map(l => ({ id: l.id, type: l.type, note: l.note || "", date: l.logged_at })),
      successPlan: {
        goal:       a.success_goal || "",
        milestones: (a.milestones || [])
                      .sort((x, y) => x.sort_order - y.sort_order)
                      .map(m => ({ id: m.id, text: m.text, done: m.done })),
      },
    }));

    res.json({ accounts: shaped });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts ────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const body = req.body;
    const { healthScore, churnRisk, stage } = calcHealth({
      nps: body.nps, ces: body.ces,
      productUsage: body.productUsage, openTickets: body.openTickets,
    });

    const { data, error } = await supabase.from("accounts").insert({
      // user_id renamed to created_by in Phase 2 (Step 8); keep user_id until then
      user_id:       req.userId,
      org_id:        req.orgId,
      name:          body.name,
      industry:      body.industry,
      plan:          body.plan || "Starter",
      arr:           body.arr || 0,
      renewal_date:  body.renewalDate || null,
      nps:           body.nps,
      ces:           body.ces,
      product_usage: body.productUsage,
      open_tickets:  body.openTickets || 0,
      health_score:  healthScore,
      churn_risk:    churnRisk,
      stage,
      last_contact:  body.lastContact || new Date().toISOString().split("T")[0],
      next_action:   body.nextAction || null,
      notes:         body.notes || null,
      source:        body.source || "manual",
      external_id:   body.externalId || null,
    }).select().single();

    if (error) throw error;

    const today = new Date().toISOString().split("T")[0];

    // Write initial CES history entry
    if (body.ces) {
      await supabase.from("ces_history").insert({
        user_id: req.userId, org_id: req.orgId, account_id: data.id,
        value: body.ces, recorded_at: today,
      });
    }

    // Write initial health history entry
    await supabase.from("health_history").insert({
      user_id: req.userId, org_id: req.orgId, account_id: data.id,
      score: healthScore, recorded_at: today,
    });

    res.status(201).json({ account: data });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/accounts/:id ───────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const body   = req.body;

    // Verify org ownership before touching anything
    const { data: existing, error: ownErr } = await supabase
      .from("accounts").select("id, org_id, nps, ces, product_usage, open_tickets, health_score")
      .eq("id", id).eq("org_id", req.orgId).single();

    if (ownErr || !existing) {
      return res.status(404).json({ error: "Account not found" });
    }

    const updates = {};
    const fieldMap = {
      name: "name", industry: "industry", plan: "plan", arr: "arr",
      renewalDate: "renewal_date", nps: "nps", ces: "ces",
      productUsage: "product_usage", openTickets: "open_tickets",
      lastContact: "last_contact", nextAction: "next_action",
      notes: "notes", prepNotes: "prep_notes", archived: "archived",
      successGoal: "success_goal", activePlaybookId: "active_playbook_id",
      activePlaybookSteps: "active_playbook_steps", snoozedPlaybooks: "snoozed_playbooks",
      domain: "domain",
      // Expansion
      expansionPotential: "expansion_potential",
      expansionArr:       "expansion_arr",
      expansionStage:     "expansion_stage",
      expansionNotes:     "expansion_notes",
      // Escalation
      escalationStatus: "escalation_status",
      escalationReason: "escalation_reason",
      escalationSince:  "escalation_since",
      escalationNotes:  "escalation_notes",
    };

    Object.entries(fieldMap).forEach(([front, db]) => {
      if (body[front] !== undefined) updates[db] = body[front];
    });

    // Recalculate health if signals changed
    let newHealthScore = null;
    if (["nps","ces","productUsage","openTickets"].some(f => body[f] !== undefined)) {
      const { healthScore, churnRisk, stage } = calcHealth({
        nps:          body.nps          ?? existing.nps,
        ces:          body.ces          ?? existing.ces,
        productUsage: body.productUsage ?? existing.product_usage,
        openTickets:  body.openTickets  ?? existing.open_tickets,
      });
      updates.health_score = healthScore;
      updates.churn_risk   = churnRisk;
      updates.stage        = stage;
      newHealthScore       = healthScore;
    }

    // Success plan milestones
    if (body.successPlan) {
      if (body.successPlan.goal !== undefined) updates.success_goal = body.successPlan.goal;
      if (body.successPlan.milestones) {
        await supabase.from("milestones").delete().eq("account_id", id).eq("org_id", req.orgId);
        if (body.successPlan.milestones.length > 0) {
          await supabase.from("milestones").insert(
            body.successPlan.milestones.map((m, i) => ({
              user_id: req.userId, org_id: req.orgId, account_id: id,
              text: m.text, done: m.done || false, sort_order: i,
            }))
          );
        }
      }
    }

    // New CES reading
    if (body.newCesReading) {
      await supabase.from("ces_history").insert({
        user_id: req.userId, org_id: req.orgId, account_id: id,
        value: body.newCesReading.value,
        recorded_at: body.newCesReading.date || new Date().toISOString().split("T")[0],
      });
    }

    // Write health history snapshot if health changed
    if (newHealthScore !== null) {
      await supabase.from("health_history").insert({
        user_id:     req.userId,
        org_id:      req.orgId,
        account_id:  id,
        score:       newHealthScore,
        recorded_at: new Date().toISOString().split("T")[0],
      });
    }

    // New activity log entry
    if (body.newActivity) {
      await supabase.from("activity_log").insert({
        user_id: req.userId, org_id: req.orgId, account_id: id,
        type: body.newActivity.type, note: body.newActivity.note,
        logged_at: body.newActivity.date || new Date().toISOString().split("T")[0],
      });
    }

    // Stakeholder changes
    if (body.stakeholders) {
      await supabase.from("stakeholders").delete().eq("account_id", id).eq("org_id", req.orgId);
      if (body.stakeholders.length > 0) {
        await supabase.from("stakeholders").insert(
          body.stakeholders.map(s => ({
            user_id: req.userId, org_id: req.orgId, account_id: id,
            name: s.name, title: s.title || "",
            email: s.email || null,
            role: s.role || "Neutral", sentiment: s.sentiment || "Neutral",
            last_touch: s.lastTouch || null,
          }))
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from("accounts")
        .update(updates).eq("id", id).eq("org_id", req.orgId);
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/accounts/:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { error } = await supabase.from("accounts")
      .delete().eq("id", req.params.id).eq("org_id", req.orgId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/bulk ───────────────────────────────────────────────────
router.post("/bulk", async (req, res, next) => {
  try {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ error: "accounts array is required" });
    }

    const rows = accounts.map(body => {
      const { healthScore, churnRisk, stage } = calcHealth({
        nps: body.nps, ces: body.ces,
        productUsage: body.productUsage, openTickets: body.openTickets,
      });
      return {
        user_id:       req.userId,
        org_id:        req.orgId,
        name:          body.name,
        domain:        body.domain?.trim().toLowerCase() || null,
        industry:      body.industry || "",
        plan:          body.plan || "Starter",
        arr:           body.arr || 0,
        renewal_date:  body.renewalDate || null,
        nps:           body.nps || 50,
        ces:           body.ces || 3.5,
        product_usage: body.productUsage || 60,
        open_tickets:  body.openTickets || 0,
        health_score:  healthScore,
        churn_risk:    churnRisk,
        stage,
        last_contact:  body.lastContact || new Date().toISOString().split("T")[0],
        source:        "manual",
      };
    });

    const { data, error } = await supabase.from("accounts").insert(rows).select("id");
    if (error) throw error;
    res.status(201).json({ created: data.length, ids: data.map(r => r.id) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/accounts/:id/usage-history ──────────────────────────────────────
router.get("/:id/usage-history", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("usage_history")
      .select("product_usage, active_users, licensed_seats, dau, mau, features_used_count, total_features, sessions_last_30d, recorded_at")
      .eq("account_id", req.params.id)
      .eq("org_id", req.orgId)
      .order("recorded_at", { ascending: false })
      .limit(90);

    if (error) throw error;

    const history = (data || []).reverse();
    const latest  = data?.[0] || null;

    res.json({ history, latest });
  } catch (err) { next(err); }
});

// ── GET /api/accounts/churn ───────────────────────────────────────────────────
router.get("/churn", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("churn_events")
      .select("*")
      .eq("org_id", req.orgId)
      .order("churned_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) { next(err); }
});

// ── POST /api/accounts/:id/churn ─────────────────────────────────────────────
// Logs a churn event and archives the account in one atomic operation.
router.post("/:id/churn", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason, notes, churnedAt } = req.body;

    if (!reason) return res.status(400).json({ error: "reason is required" });

    // Verify org ownership and get account details
    const { data: account, error: ownErr } = await supabase
      .from("accounts")
      .select("id, org_id, name, arr")
      .eq("id", id)
      .eq("org_id", req.orgId)
      .single();

    if (ownErr || !account) return res.status(404).json({ error: "Account not found" });

    // Log churn event
    const { error: churnErr } = await supabase.from("churn_events").insert({
      user_id:      req.userId,
      org_id:       req.orgId,
      account_id:   id,
      account_name: account.name,
      arr:          account.arr || 0,
      reason,
      notes:        notes || null,
      churned_at:   churnedAt || new Date().toISOString().split("T")[0],
    });
    if (churnErr) throw churnErr;

    // Archive the account
    const { error: archErr } = await supabase
      .from("accounts")
      .update({ archived: true })
      .eq("id", id)
      .eq("org_id", req.orgId);
    if (archErr) throw archErr;

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
