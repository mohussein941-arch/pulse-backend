// routes/performance.js
// Returns the CSM's own performance metrics — weekly and monthly activity,
// survey/outreach output, and portfolio health snapshot.

const express  = require("express");
const supabase = require("../supabase");

const router = express.Router();

// GET /api/performance
router.get("/", async (req, res, next) => {
  try {
    const userId = req.userId;
    const now    = new Date();

    // Week start: Monday of the current week
    const dayOfWeek = now.getDay() || 7; // JS: 0=Sun → treat as 7
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr  = weekStart.toISOString().split("T")[0];
    const weekStartISO  = weekStart.toISOString();

    // Month start
    const monthStart    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch all in parallel
    const [
      { data: actWeek },
      { data: actMonth },
      { data: surveysWeek },
      { data: outreachSent },
      { data: outreachPending },
      { data: accounts },
    ] = await Promise.all([
      // Activities logged this week
      supabase.from("activity_log")
        .select("id, type")
        .eq("user_id", userId)
        .gte("logged_at", weekStartStr),

      // Activities logged this month
      supabase.from("activity_log")
        .select("id, type")
        .eq("user_id", userId)
        .gte("logged_at", monthStart),

      // Surveys sent this week
      supabase.from("surveys")
        .select("id, type")
        .eq("user_id", userId)
        .gte("created_at", weekStartISO),

      // Outreach emails sent this week
      supabase.from("outreach_queue")
        .select("id, trigger_type")
        .eq("user_id", userId)
        .eq("status", "sent")
        .gte("created_at", weekStartISO),

      // Outreach pending (all time — needs action)
      supabase.from("outreach_queue")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "pending"),

      // Portfolio snapshot
      supabase.from("accounts")
        .select("health_score, stage, arr, escalation_status, expansion_potential")
        .eq("user_id", userId)
        .eq("archived", false),
    ]);

    // Activity breakdown by type — week
    const weekByType = {};
    (actWeek || []).forEach(a => { weekByType[a.type] = (weekByType[a.type] || 0) + 1; });

    // Activity breakdown by type — month
    const monthByType = {};
    (actMonth || []).forEach(a => { monthByType[a.type] = (monthByType[a.type] || 0) + 1; });

    // Portfolio stats
    const accs       = accounts || [];
    const scores     = accs.filter(a => a.health_score !== null).map(a => a.health_score);
    const avgHealth  = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
    const atRisk     = accs.filter(a => a.stage === "At Risk" || a.stage === "Needs Attention").length;
    const escalated  = accs.filter(a => a.escalation_status === "open").length;
    const expansion  = accs.filter(a => a.expansion_potential).length;
    const totalARR   = accs.reduce((s, a) => s + (parseFloat(a.arr) || 0), 0);

    // Stage breakdown
    const stageBreakdown = {};
    accs.forEach(a => {
      stageBreakdown[a.stage] = (stageBreakdown[a.stage] || 0) + 1;
    });

    res.json({
      week: {
        start:           weekStartStr,
        activitiesTotal: (actWeek || []).length,
        activitiesByType: weekByType,
        surveysSent:     (surveysWeek || []).length,
        outreachSent:    (outreachSent || []).length,
        outreachPending: (outreachPending || []).length,
      },
      month: {
        start:           monthStart,
        activitiesTotal: (actMonth || []).length,
        activitiesByType: monthByType,
      },
      portfolio: {
        total:          accs.length,
        avgHealth,
        atRisk,
        escalated,
        expansion,
        totalARR,
        stageBreakdown,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
