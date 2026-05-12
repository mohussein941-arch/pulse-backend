// routes/whatsapp.js
// WhatsApp Business API — survey delivery via webhook conversation flow

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Service role client — no user JWT in webhook requests
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const WA_API = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

// ─── Send a text message ──────────────────────────────────────────────────────
async function sendMessage(to, text) {
  const res = await fetch(WA_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'WhatsApp send failed');
  }
}

// ─── Score question by survey type ───────────────────────────────────────────
function scoreQuestion(type, customQuestion) {
  if (customQuestion) return `${customQuestion}\n\nReply with a number.`;
  if (type === 'NPS')  return 'On a scale of 0–10, how likely are you to recommend us to a colleague?\n\n0 = Not at all · 10 = Extremely likely';
  if (type === 'CES')  return 'On a scale of 1–7, how easy was it to work with us?\n\n1 = Very difficult · 7 = Very easy';
  if (type === 'CSAT') return 'On a scale of 1–5, how satisfied are you with our service?\n\n1 = Very dissatisfied · 5 = Very satisfied';
  return 'How would you rate your experience? Reply with a number between 1 and 10.';
}

const MAX_SCORE = { NPS: 10, CES: 7, CSAT: 5 };

// ─── Conversation handler ─────────────────────────────────────────────────────
async function handleConversation(session, from, text) {
  const survey = session.surveys;

  if (session.state === 'awaiting_score') {
    const score = parseInt(text, 10);
    const max   = MAX_SCORE[survey.type] ?? 10;

    if (isNaN(score) || score < 0 || score > max) {
      await sendMessage(from, `Please reply with a number between 0 and ${max}.`);
      return;
    }

    await supabase.from('whatsapp_sessions')
      .update({ score, state: 'awaiting_comment' })
      .eq('id', session.id);

    await sendMessage(from, `Got it — ${score}! What's the main reason for your score?\n\n(Or reply *skip* to finish)`);
    return;
  }

  if (session.state === 'awaiting_comment') {
    const comment = text.toLowerCase() === 'skip' ? null : text;

    await supabase.from('survey_responses').insert({
      survey_id:        session.survey_id,
      user_id:          session.user_id,
      score:            session.score,
      custom_answer:    comment,
    });

    if (survey.account_id) {
      await supabase.from('activity_log').insert({
        user_id:    session.user_id,
        account_id: survey.account_id,
        type:       'Note',
        note:       `WhatsApp ${survey.type} response: ${session.score}${comment ? ` — "${comment}"` : ''}`,
        logged_at:  new Date().toISOString().split('T')[0],
      });

      // Update account health fields so the score reflects immediately
      if (survey.type === 'NPS') {
        // NPS is 0–10, stored on accounts as 0–100
        await supabase.from('accounts')
          .update({ nps: session.score * 10 })
          .eq('id', survey.account_id);
      } else if (survey.type === 'CES') {
        // CES is 1–7, stored on accounts as 1–5 scale
        const normalized = Math.round((session.score / 7) * 5 * 10) / 10;
        await supabase.from('accounts')
          .update({ ces: normalized })
          .eq('id', survey.account_id);
        await supabase.from('ces_history').insert({
          user_id:    session.user_id,
          account_id: survey.account_id,
          value:      normalized,
          recorded_at: new Date().toISOString().split('T')[0],
        });
      }
    }

    await supabase.from('whatsapp_sessions')
      .update({ state: 'completed', comment })
      .eq('id', session.id);

    await sendMessage(from, 'Thank you! Your feedback means a lot to us. 🙏');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/whatsapp/webhook — Meta verification handshake
router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed' });
});

// POST /api/whatsapp/webhook — incoming messages from Meta
router.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // acknowledge immediately — Meta retries if we don't

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.text?.body) return;

    const from = message.from;
    const text = message.text.body.trim();

    // Check for an active session for this phone number
    const { data: session } = await supabase
      .from('whatsapp_sessions')
      .select('*, surveys(*)')
      .eq('phone', from)
      .neq('state', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (session) {
      await handleConversation(session, from, text);
      return;
    }

    // No active session — look for a 32-char hex survey token in the message
    const tokenMatch = text.match(/\b([a-f0-9]{32})\b/);
    if (!tokenMatch) {
      await sendMessage(from, 'Hi! To start a survey please use the WhatsApp link in your email. 😊');
      return;
    }

    const { data: survey } = await supabase
      .from('surveys')
      .select('*')
      .eq('token', tokenMatch[1])
      .eq('status', 'active')
      .maybeSingle();

    if (!survey) {
      await sendMessage(from, 'Sorry, this survey has expired or is no longer active.');
      return;
    }

    await supabase.from('whatsapp_sessions').insert({
      survey_id: survey.id,
      user_id:   survey.user_id,
      phone:     from,
      state:     'awaiting_score',
    });

    await sendMessage(from, `Hi! Thanks for taking a moment. 🙏\n\n${scoreQuestion(survey.type, survey.custom_question)}`);

  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

module.exports = router;
