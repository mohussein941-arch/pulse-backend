// requireUser — verifies the Supabase JWT in the Authorization header,
// attaches req.userId, req.orgId, and req.orgRole to every /api/* request.

const { createClient } = require("@supabase/supabase-js");
const supabase         = require("../supabase");

// Reuse a single anon-key client for JWT verification across all requests
let _anonClient = null;
const getAnonClient = () => {
  if (!_anonClient) {
    _anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _anonClient;
};

// ── JWT verification — extracts user_id and org membership from Supabase JWT ──
const requireUser = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorised — no Bearer token provided" });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    const { data: { user }, error } = await getAnonClient().auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Unauthorised — invalid or expired token" });
    }

    // Attach user ID to request — audit trail and per-user data (profiles, AI config)
    req.userId    = user.id;
    req.userEmail = user.email;

    // M0b: look up org membership and attach orgId + orgRole to every request.
    // If the user has no org row, orgId will be null and RLS will block data access
    // (surfaces as a clean empty result rather than a data leak).
    const { data: membership } = await supabase
      .from("org_members")
      .select("org_id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    req.orgId   = membership?.org_id || null;
    req.orgRole = membership?.role   || null;

    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorised — token verification failed" });
  }
};

module.exports = { requireUser };
