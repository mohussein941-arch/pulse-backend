const express  = require("express");
const supabase = require("../supabase");

const router = express.Router();

// GET /api/audit — last 200 audit events for the authenticated user
router.get("/", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("audit_log")
      .select("id, action, resource_type, resource_id, ip_address, metadata, created_at")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
