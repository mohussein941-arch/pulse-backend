/**
 * Public survey routes — no auth required.
 * These are the endpoints the customer hits when they open a survey link.
 *
 * GET  /survey/:token   — fetch survey details (type, question, account name)
 * POST /survey/:token   — submit a response
 */

const express  = require("express");
const supabase = require("../supabase");
const { calcHealth } = require("../health");

const router = express.Router();

// ── GET /survey/:token — fetch survey for the response page ───────────────────
router.get("/:token", async (req, res, next) => {
  try {
    const { data: survey, error } = await supabase
      .from("surveys")
      .select("id, account_name, type, custom_question, status, deadline")
      .eq("token", req.params.token)
      .single();

    if (error || !survey) {
      return res.status(404).json({ error: "Survey not found" });
    }
    if (survey.status === "closed") {
      return res.status(410).json({ error: "This survey is no longer accepting responses" });
    }
    if (survey.deadline && new Date(survey.deadline) < new Date()) {
      return res.status(410).json({ error: "This survey has expired" });
    }

    res.json({
      accountName:    survey.account_name,
      type:           survey.type,
      customQuestion: survey.custom_question,
    });
  } catch (err) { next(err); }
});

// ── POST /survey/:token — submit response ─────────────────────────────────────
router.post("/:token", async (req, res, next) => {
  try {
    const { score, customAnswer, respondentName, respondentEmail } = req.body;

    if (score === undefined || score === null) {
      return res.status(400).json({ error: "score is required" });
    }

    // Fetch survey with user_id and account_id
    const { data: survey, error: fetchErr } = await supabase
      .from("surveys")
      .select("id, user_id, account_id, account_name, type, status, deadline")
      .eq("token", req.params.token)
      .single();

    if (fetchErr || !survey) return res.status(404).json({ error: "Survey not found" });
    if (survey.status === "closed") return res.status(410).json({ error: "Survey is closed" });

    // Validate score range
    const maxScore = survey.type === "NPS" ? 10 : 5;
    const minScore = survey.type === "NPS" ? 0 : 1;
    if (score < minScore || score > maxScore) {
      return res.status(400).json({ error: `Score must be between ${minScore} and ${maxScore}` });
    }

    // Save the response
    await supabase.from("survey_responses").insert({
      survey_id:        survey.id,
      user_id:          survey.user_id,
      score,
      custom_answer:    customAnswer || null,
      respondent_name:  respondentName || null,
      respondent_email: respondentEmail || null,
    });

    // Update account health signals if account is linked
    if (survey.account_id) {
      // Get current account signals for health recalculation
      const { data: account } = await supabase
        .from("accounts")
        .select("nps, ces, product_usage, open_tickets")
        .eq("id", survey.account_id)
        .single();

      if (account) {
        const updates = {};

        // Map survey type to account field
        if (survey.type === "NPS") {
          // NPS 0-10 → scale to 0-100
          updates.nps = Math.round((score / 10) * 100);
        } else if (survey.type === "CES") {
          updates.ces = score;
        } else if (survey.type === "CSAT") {
          // Store CSAT as CES if no dedicated field (both 1-5 scale)
          updates.ces = score;
        }

        // Recalculate health
        const { healthScore, churnRisk, stage } = calcHealth({
          nps:          updates.nps          ?? account.nps,
          ces:          updates.ces          ?? account.ces,
          productUsage: account.product_usage,
          openTickets:  account.open_tickets,
        });

        updates.health_score = healthScore;
        updates.churn_risk   = churnRisk;
        updates.stage        = stage;

        await supabase.from("accounts")
          .update(updates)
          .eq("id", survey.account_id);

        // Log survey response as activity
        await supabase.from("activity_log").insert({
          user_id:    survey.user_id,
          account_id: survey.account_id,
          type:       "Note",
          note:       `${survey.type} survey response received — Score: ${score}${respondentName ? ` from ${respondentName}` : ""}${customAnswer ? `. Feedback: "${customAnswer}"` : ""}`,
          logged_at:  new Date().toISOString().split("T")[0],
        });

        // Add CES history entry if CES or CSAT
        if (survey.type === "CES" || survey.type === "CSAT") {
          await supabase.from("ces_history").insert({
            user_id:     survey.user_id,
            account_id:  survey.account_id,
            value:       score,
            recorded_at: new Date().toISOString().split("T")[0],
          });
        }
      }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
