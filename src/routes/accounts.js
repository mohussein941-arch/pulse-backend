/**
 * Accounts routes — all queries scoped to req.userId.
 * Ahmed from Microsoft only ever touches Ahmed's rows.
 * Sara from Noon only ever touches Sara's rows.
 * The database RLS policies enforce this as a second layer of protection.
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
        ces_history ( value, recorded_at ),
        stakeholders ( id, name, title, email, role, sentiment, last_touch ),
        activity_log ( id, type, note, logged_at ),
        milestones   ( id, text, done, sort_order )
      `)
      .eq("user_id", req.userId)
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
      productUsage: a.product_usage || 60,
      openTickets:  a.open_tickets || 0,
      healthScore:  a.health_score,
      churnRisk:    a.churn_risk,
      stage:        a.stage || "Stable",
      lastContact:  a.last_contact || new Date().toISOString().split("T")[0],
      nextAction:   a.next_action || "",
      notes:        a.notes || "",
      prepNotes:    a.prep_notes || "",
      archived:     a.archived || false,
      activePlaybookId:    a.active_playbook_id || null,
      activePlaybookSteps: a.active_playbook_steps || {},
      snoozedPlaybooks:    a.snoozed_playbooks || [],
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
      user_id:       req.userId,
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

    if (body.ces) {
      await supabase.from("ces_history").insert({
        user_id: req.userId, account_id: data.id,
        value: body.ces,
        recorded_at: new Date().toISOString().split("T")[0],
      });
    }

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

    // Verify ownership before touching anything
    const { data: existing, error: ownErr } = await supabase
      .from("accounts").select("id, user_id, nps, ces, product_usage, open_tickets")
      .eq("id", id).eq("user_id", req.userId).single();

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
    };

    Object.entries(fieldMap).forEach(([front, db]) => {
      if (body[front] !== undefined) updates[db] = body[front];
    });

    // Recalculate health if signals changed
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
    }

    // Success plan milestones
    if (body.successPlan) {
      if (body.successPlan.goal !== undefined) updates.success_goal = body.successPlan.goal;
      if (body.successPlan.milestones) {
        await supabase.from("milestones").delete().eq("account_id", id).eq("user_id", req.userId);
        if (body.successPlan.milestones.length > 0) {
          await supabase.from("milestones").insert(
            body.successPlan.milestones.map((m, i) => ({
              user_id: req.userId, account_id: id,
              text: m.text, done: m.done || false, sort_order: i,
            }))
          );
        }
      }
    }

    // New CES reading
    if (body.newCesReading) {
      await supabase.from("ces_history").insert({
        user_id: req.userId, account_id: id,
        value: body.newCesReading.value,
        recorded_at: body.newCesReading.date || new Date().toISOString().split("T")[0],
      });
    }

    // New activity log entry
    if (body.newActivity) {
      await supabase.from("activity_log").insert({
        user_id: req.userId, account_id: id,
        type: body.newActivity.type, note: body.newActivity.note,
        logged_at: body.newActivity.date || new Date().toISOString().split("T")[0],
      });
    }

    // Stakeholder changes
    if (body.stakeholders) {
      await supabase.from("stakeholders").delete().eq("account_id", id).eq("user_id", req.userId);
      if (body.stakeholders.length > 0) {
        await supabase.from("stakeholders").insert(
          body.stakeholders.map(s => ({
            user_id: req.userId, account_id: id,
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
        .update(updates).eq("id", id).eq("user_id", req.userId);
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
      .delete().eq("id", req.params.id).eq("user_id", req.userId);
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
        name:          body.name,
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

module.exports = router;
