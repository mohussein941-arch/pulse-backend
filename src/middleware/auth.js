/**
 * Auth middleware — two layers of protection:
 *
 * 1. requireApiKey  — checks x-pulse-secret header (service-to-service calls,
 *                     used by the frontend's API client)
 * 2. requireUser    — verifies the Supabase JWT in the Authorization header
 *                     and attaches req.userId for use in every route
 *
 * All /api/* routes use both. The user's JWT comes from Supabase Auth
 * after they sign in — the frontend sends it as:
 *   Authorization: Bearer <supabase_jwt>
 *   x-pulse-secret: <PULSE_API_SECRET>
 */

const { createClient } = require("@supabase/supabase-js");

// ── API secret check (prevents non-Pulse clients hitting the API) ─────────────
const requireApiKey = (req, res, next) => {
  const secret = process.env.PULSE_API_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[WARN] PULSE_API_SECRET not set — skipping in development");
      return next();
    }
    return res.status(500).json({ error: "Server misconfiguration: API secret not set" });
  }
  const provided = req.headers["x-pulse-secret"];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: "Unauthorised — invalid or missing API secret" });
  }
  next();
};

// ── JWT verification — extracts user_id from Supabase JWT ─────────────────────
const requireUser = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorised — no Bearer token provided" });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    // Use Supabase's built-in JWT verification
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY, // anon key for user-scoped auth
      { auth: { persistSession: false } }
    );

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Unauthorised — invalid or expired token" });
    }

    // Attach user ID to request — every route uses this to scope queries
    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorised — token verification failed" });
  }
};

module.exports = { requireApiKey, requireUser };
