// routes/csmProfile.js — CSM profile CRUD
//
// One profile per user (csm_profile.id = auth.uid()).
// RLS on csm_profile enforces id = current_user_id() AND org_id = current_org_id()
// at the DB layer. The service-key client bypasses RLS, so handlers scope all
// queries manually with .eq('id', req.userId).eq('org_id', req.orgId).
//
// No DELETE endpoint — intentionally omitted, matching the migration_m2b.sql design.

const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { schemas, validate } = require('../utils/validate');
const { audit } = require('../middleware/audit');

// ── Shape ─────────────────────────────────────────────────────────────────────

function shapeProfile(p) {
  return {
    career_stage:  p.career_stage,
    specialty:     p.specialty,
    working_style: p.working_style || {},
    created_at:    p.created_at,
    updated_at:    p.updated_at,
  };
}

// ── GET /api/csm-profile ──────────────────────────────────────────────────────
// Returns the authenticated user's CSM profile. Auto-creates with defaults on
// first call so that updated_at is always populated (brief cache requires it).

router.get('/', async (req, res, next) => {
  try {
    let { data: profile, error } = await supabase
      .from('csm_profile')
      .select('career_stage, specialty, working_style, created_at, updated_at')
      .eq('id',     req.userId)
      .eq('org_id', req.orgId)
      .maybeSingle();

    if (error) throw error;

    if (!profile) {
      // Auto-create with column defaults so updated_at exists from day one.
      // The brief cache depends on csm_profile.updated_at being present and
      // app-managed — a missing row would produce a null in dataStateHash.
      const { data: created, error: insertErr } = await supabase
        .from('csm_profile')
        .insert({ id: req.userId, org_id: req.orgId })
        .select('career_stage, specialty, working_style, created_at, updated_at')
        .single();

      if (insertErr) throw insertErr;
      profile = created;

      audit(req.userId, 'csm_profile.created', { req });
    }

    res.json(shapeProfile(profile));
  } catch (err) { next(err); }
});

// ── PATCH /api/csm-profile ────────────────────────────────────────────────────
// Partial update — any subset of career_stage, specialty, working_style.
// Upserts so that a first PATCH (without a preceding GET) still works cleanly.

router.patch('/', validate(schemas.csmProfileUpdate), async (req, res, next) => {
  try {
    const { career_stage, specialty, working_style } = req.body;

    const updates = {};
    if (career_stage  !== undefined) updates.career_stage  = career_stage;
    if (specialty     !== undefined) updates.specialty     = specialty;
    if (working_style !== undefined) updates.working_style = working_style;

    // App-managed updated_at — required for brief cache invalidation.
    // See migration_m2b.sql header: "Convention: updated_at on csm_profile is
    // app-managed (no trigger). The application controls update timing."
    updates.updated_at = new Date().toISOString();

    // Upsert: inserts with column defaults if the profile doesn't exist yet,
    // then applies the provided fields. On conflict (profile exists) it only
    // updates the specified columns, leaving the rest unchanged.
    const { data: upserted, error: upsertErr } = await supabase
      .from('csm_profile')
      .upsert(
        { id: req.userId, org_id: req.orgId, ...updates },
        { onConflict: 'id' }
      )
      .select('career_stage, specialty, working_style, created_at, updated_at')
      .single();

    if (upsertErr) throw upsertErr;

    audit(req.userId, 'csm_profile.updated', {
      meta: { fields: Object.keys(updates).filter(k => k !== 'updated_at') },
      req,
    });

    res.json(shapeProfile(upserted));
  } catch (err) { next(err); }
});

module.exports = router;
