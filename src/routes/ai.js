// routes/ai.js — AI config CRUD (BYOK settings UI) + native pre-call brief + account Q&A + briefing summary
// M0b: account reads scoped to req.orgId; profile reads stay per-user (Tier C)
// M4c.2: brief/chat/briefing-summary now use server-side llm.reason(); config/test routes retain BYOK path for Settings UI

const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { encrypt, decrypt, mask } = require('../utils/crypto');
const { callAI, testKey, MODELS } = require('../utils/ai');
const { schemas, validate } = require('../utils/validate');
const { audit } = require('../middleware/audit');
const { buildAccountContext } = require('../engine/accountContext');
const llm = require('../services/llm');

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getUserAiConfig(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('ai_config')
    .eq('id', userId)
    .maybeSingle();

  const cfg = data?.ai_config;
  if (!cfg?.provider || !cfg?.api_key) return null;
  return { ...cfg, api_key: decrypt(cfg.api_key) };
}

function requireAiConfig(config, res) {
  if (!config) {
    res.status(402).json({ error: 'No AI key configured. Add your API key in Settings → AI.' });
    return false;
  }
  return true;
}

// Wrap user-controlled content so it can't inject prompt instructions
function safeBlock(label, content) {
  return `<${label}>\n${content}\n</${label}>`;
}

// ── Config endpoints ──────────────────────────────────────────────────────────

// GET /api/ai/config — returns masked key (per-user, profiles is Tier C)
router.get('/config', async (req, res, next) => {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('ai_config')
      .eq('id', req.userId)
      .maybeSingle();

    const cfg = data?.ai_config;
    if (!cfg) return res.json(null);

    res.json({
      provider:     cfg.provider,
      model:        cfg.model || MODELS[cfg.provider] || null,
      api_key_mask: cfg.api_key ? mask(decrypt(cfg.api_key)) : null,
      configured:   !!cfg.api_key,
    });
  } catch (err) { next(err); }
});

// PATCH /api/ai/config — save encrypted key
router.patch('/config', validate(schemas.aiConfig), async (req, res, next) => {
  try {
    const { provider, api_key, model } = req.body;

    const cfg = {
      provider,
      api_key: encrypt(api_key),
      model:   model || MODELS[provider],
    };

    const { error } = await supabase
      .from('profiles')
      .update({ ai_config: cfg, updated_at: new Date().toISOString() })
      .eq('id', req.userId);

    if (error) throw error;

    audit(req.userId, 'ai.config_updated', { meta: { provider }, req });
    res.json({ provider, model: cfg.model, api_key_mask: mask(api_key), configured: true });
  } catch (err) { next(err); }
});

// DELETE /api/ai/config
router.delete('/config', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ ai_config: null, updated_at: new Date().toISOString() })
      .eq('id', req.userId);

    if (error) throw error;
    audit(req.userId, 'ai.config_removed', { req });
    res.json({ configured: false });
  } catch (err) { next(err); }
});

// POST /api/ai/test — verify the key works
router.post('/test', async (req, res, next) => {
  try {
    const config = await getUserAiConfig(req.userId);
    if (!requireAiConfig(config, res)) return;

    await testKey(config);
    res.json({ ok: true });
  } catch (err) {
    // Surface provider auth errors clearly
    if (err.status === 401 || err.message?.includes('auth') || err.message?.includes('key')) {
      return res.status(400).json({ error: 'Invalid API key — authentication failed.' });
    }
    next(err);
  }
});

// ── Pre-call brief ────────────────────────────────────────────────────────────

// POST /api/ai/brief/:accountId
router.post('/brief/:accountId', async (req, res, next) => {
  try {
    // Load account + related data — scoped to org (accounts is Tier B)
    const { data: account, error } = await supabase
      .from('accounts')
      .select(`
        id, name, health_score, churn_risk, nps, ces, product_usage,
        arr, plan, stage, open_tickets, renewal_date, last_contact, notes,
        activity_log ( type, logged_at, note ),
        milestones    ( text, done ),
        tasks         ( title, priority, due_date, done )
      `)
      .eq('id', req.params.accountId)
      .eq('org_id', req.orgId)
      .maybeSingle();

    if (error || !account) return res.status(404).json({ error: 'Account not found' });

    const daysAgo = d => {
      if (!d) return null;
      return Math.round((Date.now() - new Date(d).getTime()) / 86_400_000);
    };
    const daysUntil = d => {
      if (!d) return null;
      return Math.round((new Date(d).getTime() - Date.now()) / 86_400_000);
    };

    const renewal    = daysUntil(account.renewal_date);
    const lastContact = daysAgo(account.last_contact);
    const recentLog  = (account.activity_log || [])
      .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at))
      .slice(0, 5)
      .map(l => `• ${l.type} (${daysAgo(l.logged_at)}d ago)${l.note ? ': ' + l.note : ''}`)
      .join('\n') || 'No recent activity';

    const openTasks = (account.tasks || [])
      .filter(t => !t.done)
      .map(t => `• [${t.priority}] ${t.title}${t.due_date ? ' — due ' + t.due_date : ''}`)
      .join('\n') || 'None';

    const pendingMs = (account.milestones || [])
      .filter(m => !m.done)
      .map(m => `• ${m.text}`)
      .join('\n') || 'All complete';

    const accountBlock = [
      `Name: ${account.name}`,
      `Health: ${account.health_score}/100  Stage: ${account.stage}  Churn Risk: ${account.churn_risk}%`,
      `ARR: $${(account.arr || 0).toLocaleString()}  Plan: ${account.plan || '—'}`,
      `Renewal: ${account.renewal_date ? `${renewal > 0 ? renewal + 'd away' : 'OVERDUE'} (${account.renewal_date})` : '—'}`,
      `Last Contact: ${lastContact !== null ? lastContact + 'd ago' : '—'}`,
      `NPS: ${account.nps ?? '—'}  CES: ${account.ces ?? '—'}/5  Usage: ${account.product_usage ?? '—'}%  Open Tickets: ${account.open_tickets ?? 0}`,
      ``,
      `Recent Activity:\n${recentLog}`,
      ``,
      `Open Tasks:\n${openTasks}`,
      ``,
      `Pending Milestones:\n${pendingMs}`,
      ``,
      `Notes:\n${account.notes || 'None'}`,
    ].join('\n');

    const { output: brief } = await llm.reason({
      orgId:     req.orgId,
      feature:   'ask_ai_brief',
      accountId: req.params.accountId,
      createdBy: req.userId,
      system: 'You are an expert Customer Success Manager assistant. Generate precise, actionable pre-call briefs. Reference specific numbers and facts. Be concise — no padding or generic advice.',
      user: `Generate a pre-call brief for this account:\n\n${safeBlock('account_data', accountBlock)}\n\nFormat your response exactly as:\n\n**Snapshot**\n[2 sentences — account health and relationship status]\n\n**Watch Points**\n- [specific concern with data reference]\n\n**Wins to Acknowledge**\n- [positive signal]\n\n**Talking Points**\n- [specific agenda item]\n\n**Recommended Action**\n[One clear action to take on this call]`,
      maxTokens: 600,
    });

    audit(req.userId, 'ai.brief_generated', { resourceType: 'account', resourceId: req.params.accountId, req });
    res.json({ brief });
  } catch (err) { next(err); }
});

// ── Account Q&A ───────────────────────────────────────────────────────────────

// POST /api/ai/chat/:accountId
// Body: { question: string, history?: [{ role, content }] }
router.post('/chat/:accountId', async (req, res, next) => {
  try {
    const { question, history = [] } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
    if (question.length > 500) return res.status(400).json({ error: 'question too long (max 500 chars)' });

    // Build rich account context — scoped to org, query-steered semantic retrieval
    const context = await buildAccountContext({
      orgId: req.orgId, accountId: req.params.accountId, userId: req.userId,
      options: { query: question, semanticLimit: 8, maxTotalChars: 12000 },
    });

    // profile.available is false when the account row was not found for this org
    if (!context.sections.profile?.available) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Build conversation for multi-turn Q&A
    // Limit history to last 6 turns to keep token usage reasonable
    const safeHistory = (Array.isArray(history) ? history : [])
      .slice(-6)
      .filter(m => m.role && m.content)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1000) }));

    const messages = [
      ...safeHistory,
      { role: 'user', content: safeBlock('question', question) },
    ];

    const { output: answer } = await llm.reason({
      orgId:     req.orgId,
      feature:   'ask_ai_chat',
      accountId: req.params.accountId,
      createdBy: req.userId,
      system: `You are a Customer Success assistant. Answer questions about the following account based only on the data provided. If the data doesn't support a definitive answer, say so explicitly. All dates in the data are pre-computed with relative ages — no date arithmetic is needed. Respond conversationally in plain prose — no markdown headers, tables, or bullet lists. Default to 2-5 sentences; go longer only when the question genuinely requires detail.\n\n${safeBlock('account_data', context.text)}`,
      user: messages.map(m => `${m.role === 'assistant' ? 'Assistant' : 'CSM'}: ${m.content}`).join('\n\n'),
      maxTokens: 500,
    });

    audit(req.userId, 'ai.chat', { resourceType: 'account', resourceId: req.params.accountId, req });
    res.json({ answer });
  } catch (err) { next(err); }
});

// ── Briefing AI summary ───────────────────────────────────────────────────────

// POST /api/ai/briefing-summary
// Body: { items: briefing items array }
router.post('/briefing-summary', async (req, res, next) => {
  try {
    const { items = [] } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ summary: null });
    }

    const actionItems   = items.filter(i => i.category === 'action' && i.status === 'pending');
    const overdueItems  = items.filter(i => i.signalType === 'task_overdue' && i.status === 'pending');
    const wins          = items.filter(i => i.category === 'win');

    if (actionItems.length === 0 && overdueItems.length === 0) {
      return res.json({ summary: null }); // all-clear — no summary needed
    }

    const itemLines = [
      ...actionItems.slice(0, 8).map(i =>
        `• [${Math.round(i.currentScore)}pts${i.carryDays > 0 ? `, ${i.carryDays}d carrying` : ''}] ${i.accountName || 'Account'}: ${i.signalDetail}`
      ),
      ...overdueItems.slice(0, 3).map(i => `• OVERDUE TASK: ${i.signalDetail}`),
      ...wins.slice(0, 3).map(i => `• WIN: ${i.signalDetail}`),
    ].join('\n');

    const { output: summary } = await llm.reason({
      orgId:     req.orgId,
      feature:   'briefing_summary',
      createdBy: req.userId,
      system: 'You are a Customer Success expert. Write a brief, direct portfolio narrative for a CSM starting their day. Second person only ("You have...", "Your top priority..."). No bullet points — 2-3 flowing sentences maximum.',
      user: `Based on today\'s briefing items, write a 2-3 sentence narrative:\n\n${safeBlock('briefing_items', itemLines)}`,
      maxTokens: 150,
    });

    audit(req.userId, 'ai.briefing_summary', { req });
    res.json({ summary });
  } catch (err) { next(err); }
});

module.exports = router;
