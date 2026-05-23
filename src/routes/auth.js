/**
 * Auth routes — thin wrapper around Supabase Auth.
 * Supabase handles the heavy lifting: password hashing, JWT generation,
 * email verification, session management.
 *
 * POST /auth/signup   — create a new CSM account + personal org
 * POST /auth/login    — sign in, returns JWT + orgId
 * POST /auth/logout   — invalidate session
 * GET  /auth/profile  — get current user's profile
 * PATCH /auth/profile — update name, company
 */

const express   = require("express");
const { createClient } = require("@supabase/supabase-js");
const supabase  = require("../supabase");
const { requireApiKey, requireUser } = require("../middleware/auth");

const router = express.Router();

// ── POST /auth/signup ─────────────────────────────────────────────────────────
router.post("/signup", requireApiKey, async (req, res, next) => {
  try {
    const { email, password, fullName, company } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,   // skip email confirmation for now — easy to enable later
      user_metadata: { full_name: fullName || "", company: company || "" },
    });

    if (error) throw error;

    // Update profile with company info
    if (company || fullName) {
      await supabase.from("profiles").update({
        full_name: fullName || "",
        company:   company  || "",
      }).eq("id", data.user.id);
    }

    // M0b: create a personal org for this user and make them the owner.
    // Every signup creates a new org — no invite flow or domain matching in this milestone.
    const orgName = company || email.split("@")[0];
    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .insert({ name: orgName })
      .select("id")
      .single();

    if (orgErr) throw orgErr;

    await supabase.from("org_members").insert({
      org_id:  org.id,
      user_id: data.user.id,
      role:    "owner",
    });

    await supabase.from("profiles")
      .update({ org_id: org.id })
      .eq("id", data.user.id);

    res.status(201).json({
      message: "Account created successfully",
      userId:  data.user.id,
      email:   data.user.email,
      orgId:   org.id,
    });
  } catch (err) {
    if (err.message?.includes("already registered")) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    next(err);
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post("/login", requireApiKey, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Use anon client for user login
    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await anonClient.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Fetch profile and org membership in parallel
    const [profileRes, membershipRes] = await Promise.all([
      supabase.from("profiles")
        .select("full_name, company, role")
        .eq("id", data.user.id)
        .single(),
      supabase.from("org_members")
        .select("org_id, role")
        .eq("user_id", data.user.id)
        .maybeSingle(),
    ]);

    const profile    = profileRes.data;
    const membership = membershipRes.data;

    res.json({
      token:        data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt:    data.session.expires_at,
      user: {
        id:       data.user.id,
        email:    data.user.email,
        fullName: profile?.full_name || "",
        company:  profile?.company   || "",
        role:     profile?.role      || "csm",
        orgId:    membership?.org_id || null,
        orgRole:  membership?.role   || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post("/refresh", requireApiKey, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    const anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await anonClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error) return res.status(401).json({ error: "Invalid or expired refresh token" });

    res.json({
      token:        data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt:    data.session.expires_at,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /auth/profile ─────────────────────────────────────────────────────────
router.get("/profile", requireApiKey, requireUser, async (req, res, next) => {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.userId)
      .single();

    if (error) throw error;
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /auth/profile ───────────────────────────────────────────────────────
router.patch("/profile", requireApiKey, requireUser, async (req, res, next) => {
  try {
    const { fullName, company } = req.body;
    const updates = {};
    if (fullName !== undefined) updates.full_name = fullName;
    if (company  !== undefined) updates.company   = company;

    const { error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", req.userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
