const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../supabase');

const RESEARCH_MODEL = 'claude-sonnet-4-6';
const COST_INPUT_PER_TOKEN = 3 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

function buildSystem() {
  return `You are a B2B product and market research analyst helping a Customer Success Manager onboard their company into a CS platform. Research the product using web search, then return ONE structured JSON object.

Rules:
- Use web search to read the company's own website and credible third-party sources (review sites, competitor pages, industry write-ups).
- Be factual and specific. Do NOT invent features, pricing, or competitors. If something cannot be found, use null or an empty array — never guess.
- Plain, direct language. No marketing adjectives, no hype.
- Cite the URLs you actually used in "sources".
- Output ONLY the final JSON object as your last message — no surrounding prose, no code fences.`;
}

function buildUser({ productName, websiteUrl }) {
  return `Research this product and its market, then return the JSON.

Product name: ${productName}
Website: ${websiteUrl}

Return EXACTLY this shape:
{
  "overview": "2-4 sentence factual description of what the product is and does",
  "value_props": ["short value proposition"],
  "icp": "who it is for (company size, type, roles)",
  "pricing_summary": "tiers and rough pricing if public, else null",
  "positioning": "how it positions vs alternatives",
  "competitors": ["competitor name"],
  "target_verticals": [
    { "vertical": "industry/segment", "common_needs": ["..."], "stakeholders": ["typical buyer/role"], "language": "how buyers here talk / what they care about", "objections": ["common concern"] }
  ],
  "features": [
    { "name": "feature name", "problem_solved": "customer problem it addresses", "use_cases": ["..."], "personas": ["who uses it"], "tier": "plan if known else null", "trigger_keywords": ["words a customer might say that signal a need for this feature"] }
  ],
  "sources": ["https://url-you-used"]
}`;
}

function extractText(content) {
  return (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function extractJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in research output');
  return JSON.parse(text.slice(first, last + 1));
}

async function researchCompany({ orgId, productName, websiteUrl, userId }) {
  const t0 = Date.now();
  const response = await getAnthropic().messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    system: buildSystem(),
    messages: [{ role: 'user', content: buildUser({ productName, websiteUrl }) }],
  });

  const parsed = extractJson(extractText(response.content));

  try {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    await supabase.from('ai_traces').insert({
      org_id: orgId, feature: 'company_research', model: RESEARCH_MODEL,
      input_tokens: inputTokens, output_tokens: outputTokens,
      cost_usd: inputTokens * COST_INPUT_PER_TOKEN + outputTokens * COST_OUTPUT_PER_TOKEN,
      latency_ms: Date.now() - t0, created_by: userId || null,
    });
  } catch (e) { /* best-effort trace */ }

  return parsed;
}

module.exports = { researchCompany };
