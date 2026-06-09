const express = require('express');
const supabase = require('../supabase');
const { researchCompany } = require('../engine/companyResearch');

const router = express.Router();

async function loadKnowledge(orgId) {
  const { data: profile } = await supabase.from('company_profile').select('*').eq('org_id', orgId).maybeSingle();
  const { data: features } = await supabase.from('features').select('*').eq('org_id', orgId).order('name');
  return { profile: profile || null, features: features || [] };
}

function featureRows(orgId, list, defaultSource) {
  return (Array.isArray(list) ? list : []).map(f => ({
    org_id: orgId,
    name: f.name || 'Unnamed feature',
    problem_solved: f.problem_solved || null,
    use_cases: f.use_cases || [],
    personas: f.personas || [],
    tier: f.tier || null,
    trigger_keywords: f.trigger_keywords || [],
    source: f.source || defaultSource,
  }));
}

// POST /api/company-knowledge/research — AI researches the product, stores a draft
router.post('/research', async (req, res, next) => {
  try {
    const { productName, websiteUrl } = req.body;
    if (!productName || !websiteUrl) return res.status(400).json({ error: 'productName and websiteUrl are required' });

    const data = await researchCompany({ orgId: req.orgId, productName, websiteUrl, userId: req.userId });

    await supabase.from('company_profile').upsert({
      org_id: req.orgId,
      product_name: productName,
      website_url: websiteUrl,
      overview: data.overview || null,
      value_props: data.value_props || [],
      icp: data.icp || null,
      pricing_summary: data.pricing_summary || null,
      positioning: data.positioning || null,
      competitors: data.competitors || [],
      target_verticals: data.target_verticals || [],
      sources: data.sources || [],
      confirmed: false,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id' });

    await supabase.from('features').delete().eq('org_id', req.orgId);
    const rows = featureRows(req.orgId, data.features, 'research');
    if (rows.length) await supabase.from('features').insert(rows);

    res.json(await loadKnowledge(req.orgId));
  } catch (err) { next(err); }
});

// GET /api/company-knowledge
router.get('/', async (req, res, next) => {
  try { res.json(await loadKnowledge(req.orgId)); }
  catch (err) { next(err); }
});

// PATCH /api/company-knowledge — edit profile fields / confirm
router.patch('/', async (req, res, next) => {
  try {
    const allowed = ['product_name','website_url','overview','value_props','icp','pricing_summary','positioning','competitors','target_verticals','confirmed'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { error } = await supabase.from('company_profile').update(updates).eq('org_id', req.orgId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/company-knowledge/features — replace the catalog with the CS's edited list
router.put('/features', async (req, res, next) => {
  try {
    await supabase.from('features').delete().eq('org_id', req.orgId);
    const rows = featureRows(req.orgId, req.body.features, 'manual');
    if (rows.length) await supabase.from('features').insert(rows);
    const { data } = await supabase.from('features').select('*').eq('org_id', req.orgId).order('name');
    res.json({ features: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
