const express  = require("express");
const supabase = require("../supabase");
const { syncFirefliesForUser } = require("../engine/firefliesIngestion");

const router = express.Router();

// POST /api/meetings/sync — trigger Fireflies sync for current user
router.post("/sync", async (req, res, next) => {
  try {
    const result = await syncFirefliesForUser(req.userId);
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
      .eq("user_id", req.userId)
      .eq("account_id", req.params.accountId)
      .order("meeting_date", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ meetings: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
