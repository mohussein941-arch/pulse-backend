// utils/ai.js — unified AI caller for Anthropic and OpenAI (BYOK)

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');

const MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai:    'gpt-4o-mini',
};

/**
 * Call the user's configured AI provider.
 * @param {object} config  { provider, api_key, model? } — api_key is already decrypted
 * @param {object} prompt  { system, user, maxTokens? }
 * @returns {Promise<string>} plain text response
 */
async function callAI(config, { system, user, maxTokens = 1024 }) {
  const model = config.model || MODELS[config.provider];

  if (config.provider === 'anthropic') {
    const client   = new Anthropic({ apiKey: config.api_key });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return response.content[0].text;
  }

  if (config.provider === 'openai') {
    const client   = new OpenAI({ apiKey: config.api_key });
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    });
    return response.choices[0].message.content;
  }

  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Minimal test call — just enough to verify the key is valid.
 */
async function testKey(config) {
  return callAI(config, {
    system: 'You are a helpful assistant.',
    user:   'Reply with exactly: OK',
    maxTokens: 10,
  });
}

module.exports = { callAI, testKey, MODELS };
