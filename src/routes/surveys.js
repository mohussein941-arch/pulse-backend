/**
 * Survey routes (protected — CSM only)
 *
 * POST /api/surveys          — create a new survey
 * GET  /api/surveys          — list all surveys for this user
 * GET  /api/surveys/:id      — get one survey with responses
 * PATCH /api/surveys/:id     — update status (close)
 * DELETE /api/surveys/:id    — delete survey
 * POST /api/surveys/:id/send — send survey link via email (Resend)
 */

const express  = require("express");
const axios    = require("axios");
const supabase = require("../supabase");

const router = express.Router();

const BASE_URL = () => process.env.FRONTEND_URL || "http://localhost:5174";

// ── POST /api/surveys — create ────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { accountId, accountName, type, customQuestion, deadline } = req.body;

    if (!accountName || !type) {
      return res.status(400).json({ error: "accountName and type are required" });
    }
    if (!["NPS","CES","CSAT"].includes(type)) {
      return res.status(400).json({ error: "type must be NPS, CES, or CSAT" });
    }

    const { data, error } = await supabase.from("surveys").insert({
      user_id:         req.userId,
      account_id:      accountId || null,
      account_name:    accountName,
      type,
      custom_question: customQuestion || null,
      deadline:        deadline || null,
      status:          "active",
    }).select().single();

    if (error) throw error;

    res.status(201).json({
      survey: data,
      link: `${BASE_URL()}/survey/${data.token}`,
    });
  } catch (err) { next(err); }
});

// ── GET /api/surveys — list ───────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { data: surveys, error } = await supabase
      .from("surveys")
      .select(`*, survey_responses ( id, score, custom_answer, respondent_name, submitted_at )`)
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const shaped = surveys.map(s => ({
      id:             s.id,
      accountId:      s.account_id,
      accountName:    s.account_name,
      type:           s.type,
      customQuestion: s.custom_question,
      token:          s.token,
      status:         s.status,
      deadline:       s.deadline,
      createdAt:      s.created_at,
      link:           `${BASE_URL()}/survey/${s.token}`,
      responses:      (s.survey_responses || []).map(r => ({
        id:            r.id,
        score:         r.score,
        customAnswer:  r.custom_answer,
        respondentName:r.respondent_name,
        submittedAt:   r.submitted_at,
      })),
      responseCount:  (s.survey_responses || []).length,
      avgScore:       (s.survey_responses || []).length > 0
        ? Math.round((s.survey_responses.reduce((sum, r) => sum + r.score, 0) / s.survey_responses.length) * 10) / 10
        : null,
    }));

    res.json({ surveys: shaped });
  } catch (err) { next(err); }
});

// ── PATCH /api/surveys/:id — update status ────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { status } = req.body;
    const { error } = await supabase.from("surveys")
      .update({ status })
      .eq("id", req.params.id)
      .eq("user_id", req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/surveys/:id ───────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { error } = await supabase.from("surveys")
      .delete().eq("id", req.params.id).eq("user_id", req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/surveys/:id/send — send via email ───────────────────────────────
router.post("/:id/send", async (req, res, next) => {
  try {
    if (!process.env.RESEND_API_KEY) {
      return res.status(400).json({ error: "Email sending not configured. Add RESEND_API_KEY to your environment variables." });
    }

    const { recipientEmail, recipientName, customMessage } = req.body;
    if (!recipientEmail) return res.status(400).json({ error: "recipientEmail is required" });

    // Fetch the survey
    const { data: survey, error: fetchErr } = await supabase
      .from("surveys").select("*").eq("id", req.params.id).eq("user_id", req.userId).single();
    if (fetchErr || !survey) return res.status(404).json({ error: "Survey not found" });

    const link = `${BASE_URL()}/survey/${survey.token}`;
    const typeLabels = { NPS: "Net Promoter Score", CES: "Customer Effort Score", CSAT: "Customer Satisfaction" };

    // Send via Resend
    await axios.post("https://api.resend.com/emails", {
      from:    process.env.RESEND_FROM_EMAIL || "surveys@pulse.app",
      to:      recipientEmail,
      subject: `Quick ${survey.type} survey — ${survey.account_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
          <h2 style="color:#0f172a;margin-bottom:8px;">We'd love your feedback</h2>
          <p style="color:#475569;line-height:1.6;">
            ${customMessage || `Hi ${recipientName||"there"}, we have a quick ${typeLabels[survey.type]} survey for you. It takes less than 60 seconds.`}
          </p>
          <a href="${link}" style="display:inline-block;margin-top:24px;background:#4361ee;color:white;
            padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
            Take the survey →
          </a>
          <p style="color:#94a3b8;font-size:12px;margin-top:32px;">
            Or copy this link: ${link}
          </p>
        </div>
      `,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    // Log as activity on the account
    if (survey.account_id) {
      await supabase.from("activity_log").insert({
        user_id:    req.userId,
        account_id: survey.account_id,
        type:       "Email",
        note:       `${survey.type} survey sent to ${recipientEmail}`,
        logged_at:  new Date().toISOString().split("T")[0],
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
