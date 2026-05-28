-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION M2d — Playbooks table + brief engine source of truth
-- Depends on: M2c complete, organizations table present (from schema.sql)
-- Version: v1
--
-- Tables:
--   playbooks — system and org-specific playbooks; source of truth for the
--               brief engine's "Applicable playbooks" section.
--
-- Notes:
--   · Frontend App.jsx PLAYBOOK_LIBRARY constant remains as-is (dual-source
--     intentional and time-boxed — see TECH_DEBT.md).
--   · triggerCondition (JS function) is not ported; no server-side equivalent.
--   · steps jsonb includes all step fields except commsTemplate (email copy
--     omitted; transcribing 96 template strings verbatim into SQL is error-prone
--     and the backend does not read them today).
--   · scenario text column added beyond spec: it's a 4-value category field
--     ("Onboarding", "Churn Risk", "Renewal", "Executive") used by the frontend
--     filter — useful to preserve as structured data.
--
-- RLS pattern follows v4/M2b convention.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── playbooks ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playbooks (
  id          text        PRIMARY KEY,
  org_id      uuid        NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  scenario    text,
  description text        NOT NULL,
  priority    text,
  steps       jsonb,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN playbooks.org_id IS
  'NULL = system/global playbook visible to all orgs; non-null = org-specific custom playbook';

-- DELETE intentionally omitted; RLS default-denies. Matches v4/M2b pattern.
-- System playbooks (org_id IS NULL) are immutable from the app layer; the UPDATE
-- USING clause (requiring org_id = current_org_id()) already blocks writes to them.

ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playbooks_select" ON playbooks
  FOR SELECT USING (
    org_id IS NULL OR org_id = current_org_id()
  );

-- Prevents apps from inserting system playbooks (those require org_id = NULL)
CREATE POLICY "playbooks_insert" ON playbooks
  FOR INSERT WITH CHECK (
    org_id = current_org_id()
  );

-- System playbooks are immutable from the app; only org-specific ones can be updated
CREATE POLICY "playbooks_update" ON playbooks
  FOR UPDATE
  USING  (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- Supports the brief engine's filter: .or('org_id.is.null,org_id.eq.<id>').eq('active', true)
CREATE INDEX IF NOT EXISTS idx_playbooks_org_active ON playbooks (org_id, active);

CREATE OR REPLACE TRIGGER playbooks_updated_at
  BEFORE UPDATE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── Seed: 12 system playbooks (org_id = NULL) ─────────────────────────────────
-- description maps from PLAYBOOK_LIBRARY.summary (the 2–3 sentence paragraph).
-- scenario maps from PLAYBOOK_LIBRARY.scenario (the category tag).
-- One INSERT per row for readability.

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-001',
  NULL,
  'New Account Activation',
  'Onboarding',
  'Poor onboarding is the #3 driver of churn. The first 30 days set the tone for the entire relationship. Speed and personalisation are non-negotiable.',
  'Critical',
  $pb001$[
    {"id":1,"title":"Send personalised welcome email","owner":"CSM","timeline":"Day 1","action":"Reference their specific goal from the sales process — not a template opener. Make it personal."},
    {"id":2,"title":"Schedule kickoff call within 48 hours","owner":"CSM","timeline":"Day 1–2","action":"Don't let the account go cold at the handoff moment. Book before you do anything else."},
    {"id":3,"title":"Run kickoff call","owner":"CSM","timeline":"Day 3","action":"Agenda: understand their definition of success, agree on 30-day milestones, confirm all key contacts. Do not start with product demos."},
    {"id":4,"title":"Send kickoff summary email","owner":"CSM","timeline":"Day 5","action":"Document agreed milestones and responsibilities in writing. Shared ownership starts here."},
    {"id":5,"title":"First product usage check","owner":"CSM","timeline":"Day 7","action":"Check if they are logging in. If usage is zero — call immediately. Do not email. Every silent day in onboarding costs 30 days of adoption later."},
    {"id":6,"title":"Mid-onboarding check-in","owner":"CSM","timeline":"Day 14","action":"Review milestone progress. If behind, diagnose the blocker — is it technical, time, or motivation? Each has a different fix."},
    {"id":7,"title":"Share industry case study","owner":"CSM","timeline":"Day 21","action":"A relevant case study from their industry showing a customer who achieved the same goal. Reinforces the path forward."},
    {"id":8,"title":"First value review call","owner":"CSM","timeline":"Day 30","action":"Did they hit their first milestone? If yes — celebrate and set next 30-day goals. If no — activate Slow Onboarding Recovery playbook immediately."}
  ]$pb001$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-002',
  NULL,
  'Slow Onboarding Recovery',
  'Onboarding',
  'Stalled onboarding predicts churn with 70%+ accuracy. The fix is almost always a phone call, not another email.',
  'High',
  $pb002$[
    {"id":1,"title":"Call directly — do not email","owner":"CSM","timeline":"Immediately","action":"Onboarding friction is almost always diagnosed in 10 minutes on a call. Email gives them an easy way to avoid the conversation."},
    {"id":2,"title":"Diagnose the root blocker","owner":"CSM","timeline":"Day 1","action":"Four possible causes: Technical setup issue. Internal resource constraints. Lost executive support. Unclear value. Each needs a different response."},
    {"id":3,"title":"Fix technical blockers same day","owner":"CSM + Support","timeline":"Day 1–2","action":"If it's technical, involve implementation or support immediately. Speed signals seriousness. Slow responses to technical issues in onboarding are unforgivable."},
    {"id":4,"title":"Offer to run user training directly","owner":"CSM","timeline":"Day 2–3","action":"If internal resource constraints, remove the dependency on your champion doing the training. Offer to run a 30-minute session with end users yourself."},
    {"id":5,"title":"Escalate for lost executive support","owner":"CSM + Manager","timeline":"Day 2–3","action":"Get your manager or senior leader to send a personal note to their sponsor. Peer-to-peer outreach at this stage carries more weight than anything the CSM can do."},
    {"id":6,"title":"Reset the success plan","owner":"CSM","timeline":"Day 3","action":"Agree on a simplified 2-week sprint with ONE specific, achievable milestone. Small wins rebuild momentum. Don't try to catch up everything at once."}
  ]$pb002$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-003',
  NULL,
  'Executive Sponsor Introduction',
  'Onboarding',
  'Single-threaded relationships are your biggest churn risk. Getting executive air cover early protects the entire relationship.',
  'Medium',
  $pb003$[
    {"id":1,"title":"Ask your champion directly","owner":"CSM","timeline":"Week 4","action":"'Who in leadership has visibility into the outcomes we're delivering?' Do not guess — ask."},
    {"id":2,"title":"Prepare an executive ROI summary","owner":"CSM","timeline":"Week 4–5","action":"One page, outcome-focused, no product features. Executives read outcomes, not capabilities. Include: before/after metrics, time to value, what's next."},
    {"id":3,"title":"Request a 20-minute executive briefing","owner":"CSM","timeline":"Week 5","action":"Frame it as sharing early wins, not as a check-in. Go through your champion for the introduction."},
    {"id":4,"title":"Run the executive meeting","owner":"CSM + Manager","timeline":"Week 5–6","action":"Open with their business priority (reference recent news). Connect your impact to that priority. Close with one forward-looking question, not a product pitch."},
    {"id":5,"title":"Send executive follow-up within 24 hours","owner":"CSM","timeline":"Day after meeting","action":"One page. Decisions made. Next steps named. Executives respect speed and precision above all else."}
  ]$pb003$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-004',
  NULL,
  'Early Warning Response',
  'Churn Risk',
  'Accounts in the 40–55 range have a 35–50% churn probability. The window to intervene is open — don''t wait for it to close.',
  'High',
  $pb004$[
    {"id":1,"title":"Make personalised contact — reference the signal","owner":"CSM","timeline":"Day 1","action":"Do not send a generic 'just checking in' email. Reference the specific signal — it shows you're paying attention."},
    {"id":2,"title":"Book a dedicated health call","owner":"CSM","timeline":"Day 1–2","action":"Not a standard check-in — a specific call with a clear purpose. Make the customer feel you've noticed and you care."},
    {"id":3,"title":"Diagnose across 4 dimensions","owner":"CSM","timeline":"Day 2–3","action":"Product (features not working?). People (champion distracted?). Process (workflow not fitting?). Priority (business focus shifted?). One of these is the real cause."},
    {"id":4,"title":"Assign the right intervention","owner":"CSM","timeline":"Day 3","action":"Based on root cause: technical fix → support team same day. Re-engagement → reset success plan. Stakeholder → executive outreach. Priority shift → re-scope success plan."},
    {"id":5,"title":"Create a written recovery plan with the customer","owner":"CSM","timeline":"Day 3–5","action":"Shared ownership is critical. They need skin in the game. Document what you're each doing and by when."},
    {"id":6,"title":"Bi-weekly check-ins with written updates","owner":"CSM","timeline":"Ongoing","action":"Don't reduce cadence until the health score has visibly improved. Consistency is what rebuilds confidence."},
    {"id":7,"title":"Escalate to Critical Recovery if no improvement","owner":"CSM","timeline":"Day 21","action":"If health score has not improved after 21 days of active intervention, escalate immediately. Do not extend the timeline hoping things improve."}
  ]$pb004$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-005',
  NULL,
  'Critical Recovery',
  'Churn Risk',
  'Every day counts. The approach here is radically different from standard CS — radical honesty, executive involvement, and proof over promises.',
  'Critical',
  $pb005$[
    {"id":1,"title":"Escalate internally before contacting customer","owner":"CSM + Manager","timeline":"Day 1","action":"Align your manager on the situation, the risk, and the plan before anything goes to the customer. No surprises internally."},
    {"id":2,"title":"Make personal contact within 24 hours","owner":"CSM","timeline":"Day 1","action":"Not email — call. Your voice signals urgency and care that email cannot. Leave a voicemail if needed."},
    {"id":3,"title":"Listen — do not defend or pitch","owner":"CSM","timeline":"Day 1–2","action":"Open with radical honesty. Listen for 80% of the conversation. Take notes. Resist every urge to explain or solve in the moment."},
    {"id":4,"title":"Bring in a senior leader","owner":"Manager / VP CS","timeline":"Day 2–3","action":"VP of CS or CEO depending on account size. This signals the relationship matters at the highest level. Peer-to-peer contact changes the dynamic."},
    {"id":5,"title":"Send executive recovery brief within 48 hours","owner":"CSM","timeline":"Day 2–3","action":"What went wrong. What you're doing about it. What commitment you're making. Specific dates, specific owners. No vague promises."},
    {"id":6,"title":"Define one 'proof of life' milestone","owner":"CSM","timeline":"Day 3","action":"A single meaningful win you can deliver within 14 days. Give them a reason to believe before asking for anything."},
    {"id":7,"title":"Daily check-ins until milestone delivered","owner":"CSM","timeline":"Daily","action":"Do not reduce cadence until you have delivered the proof milestone and the customer has acknowledged it. Consistency is what rebuilds trust."},
    {"id":8,"title":"Formal recovery review","owner":"CSM + Manager","timeline":"Day 14–21","action":"Acknowledge what happened openly. Present the new success plan. Ask for a renewed commitment."}
  ]$pb005$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-006',
  NULL,
  'Silent Account Re-engagement',
  'Churn Risk',
  'Disengagement is the #1 predictor of churn before it becomes visible. Research before you reach out — personalisation is the difference between a response and being ignored.',
  'High',
  $pb006$[
    {"id":1,"title":"Research before reaching out","owner":"CSM","timeline":"Day 1","action":"Check their company news, LinkedIn activity, and product usage data. Personalise your outreach around something real — not 'I wanted to check in'."},
    {"id":2,"title":"First outreach — personal, no agenda","owner":"CSM","timeline":"Day 1","action":"Short, personal, no product agenda. Give them a reason to respond that isn't 'because my CSM emailed me'."},
    {"id":3,"title":"Try a different channel if no response in 5 days","owner":"CSM","timeline":"Day 6","action":"If you've been emailing, call. If you've been calling, try LinkedIn. Channel fatigue is real."},
    {"id":4,"title":"Send a value-focused email","owner":"CSM","timeline":"Day 10","action":"Give them a reason to reply. A relevant ROI insight, industry benchmark, or new feature tied to their stated goal."},
    {"id":5,"title":"Escalate through stakeholder map","owner":"CSM","timeline":"Day 14","action":"Is there another contact in the account? A colleague, their manager? Check the stakeholder map and reach out through a different person."},
    {"id":6,"title":"Permission to close the loop email","owner":"CSM","timeline":"Day 21","action":"The most effective re-engagement email in CS. Gets the highest response rate of any sequence because it gives them control."}
  ]$pb006$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-007',
  NULL,
  'Renewal Preparation',
  'Renewal',
  'Renewals won 90 days out have 3x higher expansion rates. The goal is to make renewal a natural next step, not a negotiation.',
  'High',
  $pb007$[
    {"id":1,"title":"Internal renewal readiness assessment","owner":"CSM","timeline":"90 days out","action":"Know your position before the customer does. Health score, open tickets, CES trend, stakeholder coverage, success plan progress."},
    {"id":2,"title":"Prepare ROI summary report","owner":"CSM","timeline":"Days 1–5","action":"Quantify value delivered. Time saved, revenue impacted, tickets reduced, adoption rate. Make it undeniable. Numbers that the customer can present to their own leadership."},
    {"id":3,"title":"Schedule dedicated renewal planning call","owner":"CSM","timeline":"Days 5–7","action":"Not a regular check-in — a strategic review. Frame it as planning for a strong next year."},
    {"id":4,"title":"Run renewal planning call","owner":"CSM","timeline":"Days 7–14","action":"Open with their business goals for next year first. Connect what you've delivered to those goals. Then discuss renewal naturally — not as a transaction."},
    {"id":5,"title":"Introduce expansion if appropriate","owner":"CSM","timeline":"Day 14","action":"Present expansion as part of the vision conversation — never as an add-on at the end of a renewal call."},
    {"id":6,"title":"Get verbal commitment","owner":"CSM","timeline":"Days 14–21","action":"A verbal 'yes, let's move forward' 90 days out avoids procurement delays and last-minute surprises."},
    {"id":7,"title":"Send written renewal summary","owner":"CSM","timeline":"Within 48 hours of verbal","action":"Proposed terms, timeline, and next steps in writing. Speed closes deals."}
  ]$pb007$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-008',
  NULL,
  'At-Risk Renewal',
  'Renewal',
  'This is your last realistic window to save the renewal. The approach is fundamentally different — stop all standard renewal outreach immediately.',
  'Critical',
  $pb008$[
    {"id":1,"title":"Stop standard renewal outreach immediately","owner":"CSM","timeline":"Day 1","action":"This account needs a completely different conversation. No renewal reminders, no proposal emails."},
    {"id":2,"title":"Escalate internally and agree on terms flexibility","owner":"CSM + Manager","timeline":"Day 1","action":"Agree upfront what you're willing to offer — flexibility on terms, additional support, executive involvement. Know your position before the customer call."},
    {"id":3,"title":"Call the champion directly — be honest","owner":"CSM","timeline":"Day 1–2","action":"Not email. Be honest: 'I know the experience hasn't been what we both expected. I want to make this right before the renewal conversation.'"},
    {"id":4,"title":"Diagnose the specific renewal risk","owner":"CSM","timeline":"Day 2–3","action":"Product value gap? Internal priorities shifting? Budget pressure? Competitive threat? Each requires a fundamentally different response."},
    {"id":5,"title":"Respond to competitive threat — do not discount first","owner":"CSM","timeline":"Day 3","action":"Restate your differentiated value before offering any pricing flexibility. Discounting as the first move signals you don't believe in your own product."},
    {"id":6,"title":"Respond to budget pressure — explore right-sizing","owner":"CSM","timeline":"Day 3","action":"Explore a right-sized renewal — fewer seats, shorter term, a pause option. Losing 20% ARR is better than losing 100% and the relationship."},
    {"id":7,"title":"Bring in executive peer-to-peer","owner":"Manager / VP CS","timeline":"Days 3–5","action":"A peer-to-peer executive conversation at this stage carries more weight than anything a CSM can do."},
    {"id":8,"title":"Propose a 30-day recovery sprint","owner":"CSM","timeline":"Day 5","action":"One clear, deliverable milestone before the renewal signs. Give them a reason to believe."},
    {"id":9,"title":"Get a decision before day 30","owner":"CSM","timeline":"Day 30","action":"Yes, no, or a timeline for a decision. No ambiguity. A 'no' you can work with. Ambiguity you cannot."}
  ]$pb008$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-009',
  NULL,
  'Expansion Signal',
  'Renewal',
  'Healthy accounts that aren''t expanded are a missed revenue opportunity. The key is making expansion feel like their idea, not a sales call.',
  'Medium',
  $pb009$[
    {"id":1,"title":"Identify the specific expansion signal","owner":"CSM","timeline":"Day 1","action":"More users, new use cases, new department, new geography, or feature upgrade. Know exactly what you're proposing before you call."},
    {"id":2,"title":"Book a value review call — frame it as success","owner":"CSM","timeline":"Days 1–5","action":"Do not frame it as an expansion call. Frame it as celebrating their results and planning what's next."},
    {"id":3,"title":"Open the call with their future priorities","owner":"CSM","timeline":"Days 5–7","action":"Ask about their next 6-month priorities before mentioning anything commercial. Listen for the expansion hooks."},
    {"id":4,"title":"Present expansion as the solution to their stated goal","owner":"CSM","timeline":"Day 7","action":"Connect the expansion directly to something they said. 'Given what you just told me about [goal], I think this could help' — not a product pitch."},
    {"id":5,"title":"Involve sales or account management for commercial negotiation","owner":"CSM + Sales","timeline":"Days 7–14","action":"CSM stays as the trusted advisor. Sales or AM handles the commercial conversation. Don't blur those lines."}
  ]$pb009$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-010',
  NULL,
  'QBR Preparation & Delivery',
  'Executive',
  'CS teams running consistent QBRs maintain NRR 15–20 points higher. The secret: build the review around their business, not your product.',
  'High',
  $pb010$[
    {"id":1,"title":"Sync with champion — build their agenda","owner":"CSM","timeline":"6 weeks out","action":"'What do your execs care about right now? What would make you look great to your boss?' Build the QBR around their agenda, not yours."},
    {"id":2,"title":"Pull and interpret all data","owner":"CSM","timeline":"4 weeks out","action":"Usage, adoption, ticket resolution, milestone progress, CES. Interpret it — don't just aggregate it. What does the data actually mean for their business?"},
    {"id":3,"title":"Build narrative using Before-Action-After framework","owner":"CSM","timeline":"3 weeks out","action":"Before (the pain that triggered purchase) → Action (what was adopted) → After (the business outcome). The feature is the middle of the story. The outcome is the point."},
    {"id":4,"title":"Confirm the right attendees","owner":"CSM","timeline":"2 weeks out","action":"Economic buyer must be in the room. If the budget holder isn't there, you're presenting to influencers not decision-makers."},
    {"id":5,"title":"Share deck with champion 1 week in advance","owner":"CSM","timeline":"1 week out","action":"Ask them to review and flag anything sensitive. No surprises in the room."},
    {"id":6,"title":"Open with their business priorities — not a product recap","owner":"CSM","timeline":"Meeting day","action":"First question: 'What's changed in your world since we last spoke?' This signals you're a strategic partner, not a vendor reporting."},
    {"id":7,"title":"Spend 40% of the meeting on the future","owner":"CSM","timeline":"Meeting day","action":"QBRs that are purely retrospective miss the expansion and alignment opportunity. The future half is where relationships deepen."},
    {"id":8,"title":"Close with aligned next steps — never just 'thanks for your time'","owner":"CSM","timeline":"Meeting day","action":"Every QBR should end with an agreed goal, an aligned action, or an expansion path to explore. Closing with 'thanks' stalls momentum."},
    {"id":9,"title":"Send written follow-up within 24 hours","owner":"CSM","timeline":"Day after meeting","action":"Decisions made. Next steps named. Owners assigned. Executives respect precision and follow-through above all else."}
  ]$pb010$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-011',
  NULL,
  'Executive Escalation',
  'Executive',
  'When CSM-level intervention isn''t enough, executive involvement changes the dynamic entirely. Brief your leadership completely before any contact.',
  'Critical',
  $pb011$[
    {"id":1,"title":"Brief leadership completely before any contact","owner":"CSM","timeline":"Day 1","action":"Your VP or CCO needs full context, not a surprise. Prepare a one-page brief covering the situation, history, risk, and proposed approach."},
    {"id":2,"title":"Executive reaches out peer-to-peer","owner":"VP CS / CCO / CEO","timeline":"Day 1–2","action":"Not a CSM action. VP to VP, CEO to CEO depending on account size. Brief, personal, non-defensive."},
    {"id":3,"title":"Executive-to-executive call: listen, validate, commit","owner":"VP CS / CCO","timeline":"Day 3–5","action":"Listen, validate, and commit to a specific action with a specific date. Executives respond to peers who demonstrate accountability."},
    {"id":4,"title":"CSM creates formal recovery brief within 48 hours","owner":"CSM","timeline":"Day 5–6","action":"What happened. What you're doing. What you're committing to. Specific dates, specific owners."},
    {"id":5,"title":"Establish joint working cadence","owner":"CSM + Executive","timeline":"Day 7 onward","action":"Both executive teams involved in a regular touchpoint until the account is stable. Signals sustained commitment."}
  ]$pb011$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO playbooks (id, org_id, name, scenario, description, priority, steps, active)
VALUES (
  'pb-012',
  NULL,
  'Champion Succession',
  'Executive',
  'Losing a champion without a successor is a top-3 churn risk. The window to establish a new champion closes within 2–3 weeks of their departure. Move immediately.',
  'Critical',
  $pb012$[
    {"id":1,"title":"Move immediately — the window closes fast","owner":"CSM","timeline":"Day 1","action":"If champion has left: the 2–3 week window to establish a successor is your most critical timeline in account management."},
    {"id":2,"title":"Map all remaining contacts in the account","owner":"CSM","timeline":"Day 1–2","action":"Who is next in seniority? Who was the champion working with most closely? Who attended the kickoff? Who is still active in the product?"},
    {"id":3,"title":"Get a warm introduction from the departing champion","owner":"CSM","timeline":"Day 1–2","action":"If they're still reachable, a warm handoff is worth everything. Make it easy for them to do — draft the introduction for them."},
    {"id":4,"title":"Contact the most likely successor directly","owner":"CSM","timeline":"Day 2–3","action":"Acknowledge the transition, offer continuity, ask to introduce yourself. Not a sales call — a relationship call."},
    {"id":5,"title":"Run a fresh discovery call","owner":"CSM","timeline":"Day 3–5","action":"Do NOT assume the new contact shares the former champion's goals or sentiment. Start fresh. Ask the same questions you'd ask a new account."},
    {"id":6,"title":"Rebuild the success plan from their perspective","owner":"CSM","timeline":"Days 5–10","action":"Their definition of value may be entirely different from the previous champion. Don't carry over assumptions."},
    {"id":7,"title":"Share a concise state of the account briefing","owner":"CSM","timeline":"Days 5–10","action":"What's been achieved, what's in progress, what's planned. Give them context without overwhelming them."},
    {"id":8,"title":"Map a minimum of 2 contacts going forward","owner":"CSM","timeline":"Day 10 onward","action":"Never rely on a single champion again. Use this moment as the forcing function to build a wider stakeholder map."}
  ]$pb012$::jsonb,
  true
) ON CONFLICT (id) DO NOTHING;
