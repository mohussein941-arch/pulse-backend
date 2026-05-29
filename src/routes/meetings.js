const express  = require("express");
const supabase = require("../supabase");
const { syncFirefliesForOrg } = require("../engine/firefliesIngestion");
const { generateCloseout }    = require("../engine/closeoutGenerator");
const { sendAutomationEmail } = require("../utils/emailSender");
const { validateUuidParam }   = require("../utils/validate");
const { audit }               = require("../middleware/audit");

const router = express.Router();

// POST /api/meetings/manual — log a manual meeting note
router.post("/manual", async (req, res, next) => {
  try {
    const { accountId, title, meetingDate, attendees, summary, actionItems } = req.body;
    if (!accountId) return res.status(400).json({ error: "accountId is required" });

    const meetingDay = meetingDate ? meetingDate.slice(0, 10) : new Date().toISOString().split("T")[0];

    const { data, error } = await supabase.from("meeting_notes").insert({
      user_id:         req.userId,
      org_id:          req.orgId,
      account_id:      accountId,
      fireflies_id:    `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title:           title?.trim() || "Meeting",
      meeting_date:    new Date(meetingDay).toISOString(),
      participants:    Array.isArray(attendees) ? attendees : (attendees || "").split(",").map(s => s.trim()).filter(Boolean),
      summary:         summary?.trim() || null,
      action_items:    actionItems?.trim() || null,
      organizer_email: null,
      synced_at:       new Date().toISOString(),
    }).select("*").single();

    if (error) throw error;

    // Update last_contact if this meeting is more recent
    const { data: acct } = await supabase.from("accounts")
      .select("last_contact").eq("id", accountId).eq("org_id", req.orgId).maybeSingle();
    if (acct && (!acct.last_contact || meetingDay > acct.last_contact)) {
      await supabase.from("accounts")
        .update({ last_contact: meetingDay })
        .eq("id", accountId).eq("org_id", req.orgId);
    }

    res.status(201).json({ success: true, meeting: data });
  } catch (err) { next(err); }
});

// POST /api/meetings/sync — trigger Fireflies sync for current org
router.post("/sync", async (req, res, next) => {
  try {
    const result = await syncFirefliesForOrg(req.orgId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/meetings/:accountId — fetch meeting notes for an account
router.get("/:accountId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("meeting_notes")
      .select("*")
      .eq("org_id", req.orgId)
      .eq("account_id", req.params.accountId)
      .order("meeting_date", { ascending: false })
      .limit(50);

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.json({ meetings: [] });
    }

    const firefliesMeetings = data.filter(
      m => m.fireflies_id && !m.fireflies_id.startsWith("manual-")
    );
    const externalIds = firefliesMeetings.map(m => `fireflies:${m.fireflies_id}`);

    let transcriptRows = [];
    if (externalIds.length > 0) {
      const { data: trData, error: trErr } = await supabase
        .from("interactions")
        .select("external_id")
        .eq("org_id", req.orgId)
        .eq("source", "call_transcript")
        .in("external_id", externalIds);
      if (trErr) throw trErr;
      transcriptRows = trData || [];
    }

    const transcriptFirefliesIds = new Set(
      transcriptRows.map(r => r.external_id.replace(/^fireflies:/, ""))
    );

    const meetings = data.map(m => ({
      ...m,
      has_transcript: m.fireflies_id
        ? transcriptFirefliesIds.has(m.fireflies_id)
        : false,
    }));

    res.json({ meetings });
  } catch (err) { next(err); }
});

// ── m3c closeout handlers ─────────────────────────────────────────────────────

// POST /api/meetings/:id/closeout — generate or return cached closeout
router.post("/:id/closeout", validateUuidParam("id"), async (req, res, next) => {
  try {
    if (req.body?.force === true) {
      await supabase
        .from("closeouts")
        .delete()
        .eq("org_id", req.orgId)
        .eq("meeting_notes_id", req.params.id);
    }

    let result;
    try {
      result = await generateCloseout({
        orgId:          req.orgId,
        meetingNotesId: req.params.id,
        userId:         req.userId,
      });
    } catch (err) {
      if (
        err.message.includes("must be linked to an account") ||
        err.message.includes("No transcript found")
      ) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    if (!result) return res.status(404).json({ error: "Meeting not found" });

    audit(req.userId, "closeout.generated", {
      resourceType: "meeting_notes",
      resourceId:   req.params.id,
      meta:         { from_cache: result.fromCache, forced: req.body?.force === true },
      req,
    });

    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/meetings/:id/accept-tasks — batch-create accepted tasks
router.post("/:id/accept-tasks", validateUuidParam("id"), async (req, res, next) => {
  try {
    const { tasks } = req.body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: "tasks must be a non-empty array" });
    }

    const validPriorities = new Set(["low", "medium", "high"]);
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t.title || typeof t.title !== "string" || !t.title.trim()) {
        return res.status(400).json({ error: `tasks[${i}].title must be a non-empty string` });
      }
      if (!validPriorities.has(t.priority)) {
        return res.status(400).json({ error: `tasks[${i}].priority must be low, medium, or high` });
      }
      if (!Number.isInteger(t.due_in_days) || t.due_in_days < 0) {
        return res.status(400).json({ error: `tasks[${i}].due_in_days must be an integer >= 0` });
      }
    }

    const { data: meeting } = await supabase
      .from("meeting_notes")
      .select("id, account_id, accounts(name)")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .maybeSingle();

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });
    if (!meeting.account_id) return res.status(400).json({ error: "Meeting is not linked to an account" });

    const now = Date.now();
    const rows = tasks.map(t => ({
      user_id:      req.userId,
      org_id:       req.orgId,
      account_id:   meeting.account_id,
      account_name: meeting.accounts?.name || null,
      title:        t.title.trim(),
      description:  t.description?.trim() || null,
      priority:     t.priority.charAt(0).toUpperCase() + t.priority.slice(1),
      due_date:     new Date(now + t.due_in_days * 86400000).toISOString().split("T")[0],
      source:       "closeout",
    }));

    const { data: created, error: insertErr } = await supabase
      .from("tasks")
      .insert(rows)
      .select("*");

    if (insertErr) throw insertErr;

    audit(req.userId, "closeout.tasks_accepted", {
      resourceType: "meeting_notes",
      resourceId:   req.params.id,
      meta:         { count: created.length },
      req,
    });

    res.status(201).json({ tasks: created });
  } catch (err) { next(err); }
});

// POST /api/meetings/:id/send-followup — send follow-up email
router.post("/:id/send-followup", validateUuidParam("id"), async (req, res, next) => {
  try {
    const to      = req.body?.to?.trim();
    const subject = req.body?.subject?.trim();
    const body    = req.body?.body?.trim();

    if (!to)      return res.status(400).json({ error: "to is required" });
    if (!subject) return res.status(400).json({ error: "subject is required" });
    if (!body)    return res.status(400).json({ error: "body is required" });

    const { data: meeting } = await supabase
      .from("meeting_notes")
      .select("id")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .maybeSingle();

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });

    const htmlBody = "<p>" + body.replace(/\n/g, "<br>") + "</p>";
    const sent = await sendAutomationEmail(req.userId, to, subject, htmlBody);

    if (!sent) {
      return res.status(400).json({
        error: "No connected email account found. Connect Gmail or Outlook in Settings.",
      });
    }

    audit(req.userId, "closeout.followup_sent", {
      resourceType: "meeting_notes",
      resourceId:   req.params.id,
      meta:         { to, subject_preview: subject.slice(0, 80) },
      req,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/meetings/:id/accept-crm-update — log accepted CRM update as an interaction
router.post("/:id/accept-crm-update", validateUuidParam("id"), async (req, res, next) => {
  try {
    const content = req.body?.content?.trim();
    if (!content) return res.status(400).json({ error: "content is required" });

    const { data: meeting } = await supabase
      .from("meeting_notes")
      .select("id, account_id")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .maybeSingle();

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });
    if (!meeting.account_id) return res.status(400).json({ error: "Meeting is not linked to an account" });

    const { data: interaction, error: insertErr } = await supabase
      .from("interactions")
      .insert({
        org_id:      req.orgId,
        account_id:  meeting.account_id,
        source:      "internal_note",
        direction:   "internal",
        content,
        occurred_at: new Date().toISOString(),
        created_by:  req.userId,
        metadata: {
          meeting_notes_id: req.params.id,
          triggered_by:     "closeout_crm_update",
        },
      })
      .select("*")
      .single();

    if (insertErr) throw insertErr;

    audit(req.userId, "closeout.crm_update_accepted", {
      resourceType: "meeting_notes",
      resourceId:   req.params.id,
      req,
    });

    res.status(201).json({ interaction });
  } catch (err) { next(err); }
});

// POST /api/meetings/:id/log-health-signal — log accepted health signal as an interaction
router.post("/:id/log-health-signal", validateUuidParam("id"), async (req, res, next) => {
  try {
    const { direction, magnitude, rationale } = req.body || {};

    const validDirections  = new Set(["positive", "neutral", "negative"]);
    const validMagnitudes  = new Set(["minor", "moderate", "significant"]);

    if (!validDirections.has(direction)) {
      return res.status(400).json({ error: "direction must be positive, neutral, or negative" });
    }
    if (!validMagnitudes.has(magnitude)) {
      return res.status(400).json({ error: "magnitude must be minor, moderate, or significant" });
    }
    if (!rationale || typeof rationale !== "string" || !rationale.trim()) {
      return res.status(400).json({ error: "rationale is required" });
    }

    const { data: meeting } = await supabase
      .from("meeting_notes")
      .select("id, account_id")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .maybeSingle();

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });
    if (!meeting.account_id) return res.status(400).json({ error: "Meeting is not linked to an account" });

    const { data: interaction, error: insertErr } = await supabase
      .from("interactions")
      .insert({
        org_id:      req.orgId,
        account_id:  meeting.account_id,
        source:      "health_signal",
        direction:   "internal",
        content:     rationale.trim(),
        occurred_at: new Date().toISOString(),
        created_by:  req.userId,
        metadata: {
          health_signal_direction: direction,
          health_signal_magnitude: magnitude,
          meeting_notes_id:        req.params.id,
          triggered_by:            "closeout_health_signal",
        },
      })
      .select("*")
      .single();

    if (insertErr) throw insertErr;

    audit(req.userId, "closeout.health_signal_logged", {
      resourceType: "meeting_notes",
      resourceId:   req.params.id,
      meta:         { direction, magnitude },
      req,
    });

    res.status(201).json({ interaction });
  } catch (err) { next(err); }
});

module.exports = router;
