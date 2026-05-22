const express  = require("express");
const supabase = require("../supabase");
const { syncFirefliesForOrg } = require("../engine/firefliesIngestion");

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
    res.json({ meetings: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
