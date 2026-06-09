const express = require('express');
const multer = require('multer');
const officeParser = require('officeparser');
const supabase = require('../supabase');
const { researchCompany } = require('../engine/companyResearch');

const router = express.Router();
const CORPUS_CHAR_CAP = 12000;
const DOC_CHAR_CAP = 50000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

async function loadKnowledge(orgId) {
  const { data: profile } = await supabase.from('company_profile').select('*').eq('org_id', orgId).maybeSingle();
  const { data: features } = await supabase.from('features').select('*').eq('org_id', orgId).order('name');
  return { profile: profile || null, features: features || [] };
}

function rowFromFeature(orgId, f, source, locked) {
  return {
    org_id: orgId,
    name: f.name || 'Unnamed feature',
    problem_solved: f.problem_solved || null,
    use_cases: f.use_cases || [],
    personas: f.personas || [],
    tier: f.tier || null,
    trigger_keywords: f.trigger_keywords || [],
    source,
    locked,
  };
}

function renderResearchText(data) {
  const lines = [];
  if (data.overview) lines.push(`Overview: ${data.overview}`);
  if (Array.isArray(data.value_props) && data.value_props.length) lines.push(`Value props: ${data.value_props.join('; ')}`);
  if (data.positioning) lines.push(`Positioning: ${data.positioning}`);
  if (data.pricing_summary) lines.push(`Pricing: ${data.pricing_summary}`);
  if (Array.isArray(data.competitors) && data.competitors.length) lines.push(`Competitors: ${data.competitors.join(', ')}`);
  if (Array.isArray(data.features) && data.features.length) {
    lines.push('Features:');
    for (const f of data.features) lines.push(`- ${f.name}: ${f.problem_solved || ''}`);
  }
  if (Array.isArray(data.sources) && data.sources.length) lines.push(`Sources: ${data.sources.join(', ')}`);
  return lines.join('\n');
}

async function buildPriorKnowledge(orgId) {
  const parts = [];
  const { data: docs } = await supabase
    .from('knowledge_documents').select('kind,title,content_text,created_at')
    .eq('org_id', orgId).order('created_at', { ascending: false }).limit(20);
  for (const d of (docs || [])) {
    if (d.content_text) parts.push(`[${d.kind} — ${d.title || ''}]\n${d.content_text}`);
  }
  const { data: feats } = await supabase.from('features').select('name').eq('org_id', orgId);
  if (feats && feats.length) parts.push(`Known feature names: ${feats.map(f => f.name).join(', ')}`);
  let text = parts.join('\n\n');
  if (text.length > CORPUS_CHAR_CAP) text = text.slice(0, CORPUS_CHAR_CAP);
  return text;
}

async function mergeFeatures(orgId, incoming) {
  const { data: existing } = await supabase.from('features').select('id,name,locked').eq('org_id', orgId);
  const byName = new Map();
  for (const e of (existing || [])) byName.set((e.name || '').toLowerCase(), e);

  const toInsert = [];
  for (const f of (incoming || [])) {
    const key = (f.name || '').toLowerCase();
    const ex = byName.get(key);
    if (!ex) {
      toInsert.push(rowFromFeature(orgId, f, 'research', false));
    } else if (ex.locked) {
      continue;
    } else {
      await supabase.from('features').update({
        problem_solved: f.problem_solved || null,
        use_cases: f.use_cases || [],
        personas: f.personas || [],
        tier: f.tier || null,
        trigger_keywords: f.trigger_keywords || [],
        source: 'research',
        updated_at: new Date().toISOString(),
      }).eq('id', ex.id);
    }
  }
  if (toInsert.length) await supabase.from('features').insert(toInsert);
}

// POST /api/company-knowledge/research
router.post('/research', async (req, res, next) => {
  try {
    const { productName, websiteUrl } = req.body;
    if (!productName || !websiteUrl) return res.status(400).json({ error: 'productName and websiteUrl are required' });

    const { data: existingProfile } = await supabase
      .from('company_profile').select('*').eq('org_id', req.orgId).maybeSingle();

    const priorKnowledge = await buildPriorKnowledge(req.orgId);
    const data = await researchCompany({ orgId: req.orgId, productName, websiteUrl, userId: req.userId, priorKnowledge });

    await supabase.from('knowledge_documents').insert({
      org_id: req.orgId,
      kind: 'web_research',
      title: `Web research ${new Date().toISOString().slice(0, 10)}`,
      source: websiteUrl,
      content_text: renderResearchText(data),
    });

    await mergeFeatures(req.orgId, data.features);

    const candidate = {
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
      generated_at: new Date().toISOString(),
    };

    if (existingProfile && existingProfile.confirmed === true) {
      await supabase.from('company_profile').update({
        profile_draft: candidate, has_draft: true, updated_at: new Date().toISOString(),
      }).eq('org_id', req.orgId);
    } else {
      await supabase.from('company_profile').upsert({
        org_id: req.orgId, ...candidate, confirmed: false,
        has_draft: false, profile_draft: null, updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id' });
    }

    res.json(await loadKnowledge(req.orgId));
  } catch (err) { next(err); }
});

// GET /api/company-knowledge
router.get('/', async (req, res, next) => {
  try { res.json(await loadKnowledge(req.orgId)); }
  catch (err) { next(err); }
});

// GET /api/company-knowledge/documents
router.get('/documents', async (req, res, next) => {
  try {
    const { data } = await supabase
      .from('knowledge_documents').select('id,kind,title,source,created_at')
      .eq('org_id', req.orgId).order('created_at', { ascending: false });
    res.json({ documents: data || [] });
  } catch (err) { next(err); }
});

// POST /api/company-knowledge/documents — upload + extract text into the corpus
router.post('/documents', upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const inserted = [];
    const failed = [];
    for (const f of files) {
      let text = '';
      try {
        const ext = f.originalname.split('.').pop().toLowerCase();
        const ast = await officeParser.parseOffice(f.buffer, { fileType: ext });
        text = ast.toText();
      } catch (e) {
        failed.push({ name: f.originalname, reason: 'Could not read file' });
        continue;
      }
      text = (text || '').trim();
      if (!text) { failed.push({ name: f.originalname, reason: 'No text found' }); continue; }
      if (text.length > DOC_CHAR_CAP) text = text.slice(0, DOC_CHAR_CAP);

      const { data, error } = await supabase.from('knowledge_documents').insert({
        org_id: req.orgId,
        kind: 'document',
        title: f.originalname,
        source: f.originalname,
        content_text: text,
      }).select('id,kind,title,source,created_at').maybeSingle();

      if (error) { failed.push({ name: f.originalname, reason: 'Save failed' }); continue; }
      inserted.push(data);
    }

    const { data: documents } = await supabase
      .from('knowledge_documents').select('id,kind,title,source,created_at')
      .eq('org_id', req.orgId).order('created_at', { ascending: false });

    res.json({ documents: documents || [], inserted, failed });
  } catch (err) { next(err); }
});

// DELETE /api/company-knowledge/documents/:id
router.delete('/documents/:id', async (req, res, next) => {
  try {
    const { error } = await supabase.from('knowledge_documents')
      .delete().eq('org_id', req.orgId).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/company-knowledge/apply-draft
router.post('/apply-draft', async (req, res, next) => {
  try {
    const { data: profile } = await supabase.from('company_profile').select('*').eq('org_id', req.orgId).maybeSingle();
    if (!profile || !profile.has_draft || !profile.profile_draft) {
      return res.status(400).json({ error: 'No draft to apply' });
    }
    const d = profile.profile_draft;
    await supabase.from('company_profile').update({
      product_name: d.product_name ?? profile.product_name,
      website_url: d.website_url ?? profile.website_url,
      overview: d.overview ?? null,
      value_props: d.value_props ?? [],
      icp: d.icp ?? null,
      pricing_summary: d.pricing_summary ?? null,
      positioning: d.positioning ?? null,
      competitors: d.competitors ?? [],
      target_verticals: d.target_verticals ?? [],
      sources: d.sources ?? [],
      generated_at: d.generated_at ?? new Date().toISOString(),
      has_draft: false, profile_draft: null, updated_at: new Date().toISOString(),
    }).eq('org_id', req.orgId);
    res.json(await loadKnowledge(req.orgId));
  } catch (err) { next(err); }
});

// POST /api/company-knowledge/discard-draft
router.post('/discard-draft', async (req, res, next) => {
  try {
    await supabase.from('company_profile').update({
      has_draft: false, profile_draft: null, updated_at: new Date().toISOString(),
    }).eq('org_id', req.orgId);
    res.json(await loadKnowledge(req.orgId));
  } catch (err) { next(err); }
});

// PATCH /api/company-knowledge
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

// PUT /api/company-knowledge/features
router.put('/features', async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body.features) ? req.body.features : [];
    await supabase.from('features').delete().eq('org_id', req.orgId);
    const rows = incoming.map(f => rowFromFeature(
      req.orgId, f, f.source || 'manual', f.locked === undefined ? true : !!f.locked
    ));
    if (rows.length) await supabase.from('features').insert(rows);
    const { data } = await supabase.from('features').select('*').eq('org_id', req.orgId).order('name');
    res.json({ features: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
