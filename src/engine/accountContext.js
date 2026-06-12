'use strict';

const defaultSupabase = require('../supabase');
const { synthesizeHealth }   = require('./healthSynthesis');
const { matchOpportunities } = require('./opportunityMatcher');
const { getContext }         = require('../services/context-engine/retrieval');

// ── Date helper ───────────────────────────────────────────────────────────────
// now is pre-computed once by the orchestrator so every section shares the
// same reference point. Downstream prompts never need date arithmetic.
function fmtDate(isoStr, now) {
  if (!isoStr) return 'unknown';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return String(isoStr);
  const diffDays = Math.round((now.getTime() - d.getTime()) / 86400000);
  const dateStr  = d.toISOString().slice(0, 10);
  if (diffDays === 0)  return `${dateStr} (today)`;
  if (diffDays  >  0)  return `${dateStr} (${diffDays}d ago)`;
  return `${dateStr} (in ${-diffDays}d)`;
}

// ── Per-section budget enforcement ───────────────────────────────────────────
function applyBudget(text, budget) {
  if (!text || text.length <= budget) return { out: text || '', truncated: false };
  let cut = text.lastIndexOf(' ', budget);
  if (cut <= 0) cut = budget;
  return { out: text.slice(0, cut) + '…[truncated]', truncated: true };
}

// ── Inline field truncation with ellipsis ─────────────────────────────────────
function trunc(str, n) {
  if (!str || str.length <= n) return str || '';
  return str.slice(0, n) + '…';
}

// ── Generic item-count extractor ──────────────────────────────────────────────
function computeItemCounts(data) {
  if (!data || typeof data !== 'object') return {};
  const counts = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) counts[k] = v.length;
  }
  return counts;
}

// ── Section registry ──────────────────────────────────────────────────────────
// Ordered array of { name, budget, gather(ctx), render(data, ctx) }.
// ctx = { orgId, accountId, userId, db, options, now }.
// gather returning null   → intentionally excluded (no error, available=false).
// render returning null   → intentionally excluded.
// Either throwing         → non-fatal; section marked available=false.

const SECTIONS = [

  // ── 1. profile ──────────────────────────────────────────────────────────────
  {
    name: 'profile',
    budget: 2000,
    async gather({ orgId, accountId, db }) {
      const { data } = await db
        .from('accounts')
        .select([
          'name', 'industry', 'plan', 'stage', 'arr', 'renewal_date',
          'health_score', 'churn_risk', 'nps', 'ces', 'product_usage',
          'last_contact', 'next_action', 'notes', 'success_goal',
          'expansion_potential', 'expansion_arr', 'expansion_stage', 'expansion_notes',
          'escalation_status', 'escalation_reason', 'escalation_since', 'escalation_notes',
        ].join(', '))
        .eq('id', accountId).eq('org_id', orgId)
        .maybeSingle();
      return data ? { account: data } : null;
    },
    render({ account }, { now }) {
      const lines = [
        `Name: ${account.name}`,
        account.industry ? `Industry: ${account.industry}` : null,
        `Plan: ${account.plan || 'unknown'} | Stage: ${account.stage || 'unknown'}`,
        `ARR: ${account.arr != null ? `$${Number(account.arr).toLocaleString()}` : 'unknown'}`,
        `Renewal: ${account.renewal_date ? fmtDate(account.renewal_date, now) : 'not set'}`,
        `Health: ${account.health_score ?? 'unknown'}/100 | Churn risk: ${account.churn_risk != null ? `${account.churn_risk}%` : 'unknown'}`,
        `NPS: ${account.nps ?? 'unknown'} | CES: ${account.ces ?? 'unknown'}`,
        `Product usage: ${account.product_usage != null ? `${account.product_usage}%` : 'unknown'}`,
        `Last contact: ${fmtDate(account.last_contact, now)}`,
        account.next_action  ? `Next action: ${account.next_action}`   : null,
        account.notes        ? `Notes: ${account.notes}`               : null,
        account.success_goal ? `Success goal: ${account.success_goal}` : null,
      ].filter(Boolean);

      if (account.expansion_potential) {
        const arr = account.expansion_arr != null ? `$${Number(account.expansion_arr).toLocaleString()}` : 'unknown';
        lines.push(`\nExpansion: ${account.expansion_stage || 'identified'} | Potential ARR: ${arr}${account.expansion_notes ? ` | ${account.expansion_notes}` : ''}`);
      }
      if (account.escalation_status) {
        lines.push(`\nEscalation: ${account.escalation_status} since ${fmtDate(account.escalation_since, now)} | Reason: ${account.escalation_reason || 'unspecified'}${account.escalation_notes ? ` | ${account.escalation_notes}` : ''}`);
      }
      return lines.join('\n');
    },
  },

  // ── 2. stakeholders ─────────────────────────────────────────────────────────
  {
    name: 'stakeholders',
    budget: 1200,
    async gather({ orgId, accountId, db }) {
      const { data } = await db
        .from('stakeholders')
        .select('name, title, role, sentiment, email, last_touch')
        .eq('account_id', accountId).eq('org_id', orgId);
      return { rows: data || [] };
    },
    render({ rows }, { now }) {
      if (!rows.length) return 'No stakeholders on record.';
      return rows.map(s => {
        const parts = [s.name];
        if (s.title) parts.push(s.title);
        parts.push(`[${s.role || 'unknown'} / ${s.sentiment || 'unknown'}]`);
        if (s.email) parts.push(s.email);
        parts.push(`last touch: ${fmtDate(s.last_touch, now)}`);
        return parts.join(' | ');
      }).join('\n');
    },
  },

  // ── 3. workstreams ───────────────────────────────────────────────────────────
  {
    name: 'workstreams',
    budget: 1800,
    async gather({ orgId, accountId, db, now }) {
      const todayStr = now.toISOString().slice(0, 10);

      const [
        { data: accountWS },
        { data: rawTasks },
        { data: milestones },
      ] = await Promise.all([
        db.from('accounts')
          .select('active_playbook_id, active_playbook_steps')
          .eq('id', accountId).eq('org_id', orgId).maybeSingle(),
        db.from('tasks')
          .select('id, title, priority, due_date')
          .eq('account_id', accountId).eq('org_id', orgId).eq('done', false)
          .order('due_date', { ascending: true })
          .limit(25),
        db.from('milestones')
          .select('text')
          .eq('account_id', accountId).eq('org_id', orgId).eq('done', false),
      ]);

      const tasks = (rawTasks || []).map(t => ({
        ...t,
        overdue: !!t.due_date && t.due_date < todayStr,
      }));

      let playbookName = null;
      if (accountWS?.active_playbook_id) {
        const { data: pb } = await db.from('playbooks')
          .select('name')
          .eq('id', accountWS.active_playbook_id)
          .maybeSingle();
        playbookName = pb?.name || null;
      }

      return {
        tasks,
        milestones:    milestones || [],
        playbookId:    accountWS?.active_playbook_id    || null,
        playbookName,
        playbookSteps: accountWS?.active_playbook_steps || {},
      };
    },
    render({ tasks, milestones, playbookName, playbookId, playbookSteps }, { now }) {
      const lines = [`Open tasks (${tasks.length}):`];
      if (tasks.length) {
        for (const t of tasks) {
          const due  = t.due_date ? ` due ${fmtDate(t.due_date, now)}` : '';
          const flag = t.overdue ? ' ⚠ OVERDUE' : '';
          lines.push(`  [${t.priority}] ${t.title}${due}${flag}`);
        }
      } else {
        lines.push('  none');
      }

      lines.push(`\nPending milestones (${milestones.length}):`);
      if (milestones.length) {
        for (const m of milestones) lines.push(`  - ${m.text}`);
      } else {
        lines.push('  none');
      }

      if (playbookId) {
        lines.push(`\nActive playbook: ${playbookName || playbookId}`);
        const steps = playbookSteps && typeof playbookSteps === 'object' && !Array.isArray(playbookSteps)
          ? Object.entries(playbookSteps)
          : [];
        if (steps.length) {
          const done    = steps.filter(([, v]) =>  !!v);
          const pending = steps.filter(([, v]) => !v);
          lines.push(`  Progress: ${done.length}/${steps.length} steps done`);
          for (const [k] of pending.slice(0, 8)) lines.push(`  [ ] ${k}`);
        }
      } else {
        lines.push('\nNo active playbook.');
      }
      return lines.join('\n');
    },
  },

  // ── 4. onboarding ────────────────────────────────────────────────────────────
  {
    name: 'onboarding',
    budget: 1800,
    async gather({ orgId, accountId, db }) {
      const [
        { data: plan },
        { data: blockedTasks },
        { data: needs },
      ] = await Promise.all([
        db.from('onboarding_plans')
          .select('id, status, current_phase, go_live_target, go_live_actual, phases')
          .eq('account_id', accountId).eq('org_id', orgId).eq('status', 'active')
          .maybeSingle(),
        db.from('onboarding_tasks')
          .select('title, status, owner, due_date')
          .eq('account_id', accountId).eq('org_id', orgId)
          .in('status', ['blocked', 'in_progress'])
          .limit(15),
        db.from('account_needs')
          .select('category, description, priority, status')
          .eq('account_id', accountId).eq('org_id', orgId)
          .neq('status', 'resolved'),
      ]);
      return { plan: plan || null, tasks: blockedTasks || [], needs: needs || [] };
    },
    render({ plan, tasks, needs }, { now }) {
      if (!plan) return 'No active onboarding plan.';
      const lines = [
        `Phase: ${plan.current_phase}`,
        `Go-live target: ${fmtDate(plan.go_live_target, now)} | Actual: ${fmtDate(plan.go_live_actual, now)}`,
      ];

      if (plan.phases && typeof plan.phases === 'object') {
        const ORDER = ['handover', 'kickoff', 'configuration', 'training', 'go_live', 'value_realized'];
        const completed = ORDER.filter(p => {
          const ph = plan.phases[p];
          return ph && (ph.actual || ph.completed || ph.done);
        });
        lines.push(`Phases complete: ${completed.length ? completed.join(', ') : 'none'}`);
      }

      lines.push(`\nActive/blocked tasks (${tasks.length}):`);
      if (tasks.length) {
        for (const t of tasks) {
          const due = t.due_date ? ` due ${fmtDate(t.due_date, now)}` : '';
          lines.push(`  [${t.owner}] ${t.title} — ${t.status}${due}`);
        }
      } else {
        lines.push('  none');
      }

      if (needs.length) {
        lines.push(`\nAccount needs (${needs.length}):`);
        const byCategory = {};
        for (const n of needs) (byCategory[n.category] = byCategory[n.category] || []).push(n);
        for (const [cat, items] of Object.entries(byCategory)) {
          lines.push(`  ${cat}:`);
          for (const i of items) lines.push(`    [${i.priority}] ${i.description}`);
        }
      }
      return lines.join('\n');
    },
  },

  // ── 5. health_trajectory ─────────────────────────────────────────────────────
  {
    name: 'health_trajectory',
    budget: 1500,
    async gather({ orgId, accountId, db, now }) {
      const since90 = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);

      const [synthesis, { data: usageRow }, { data: healthHist }, { data: cesHist }] =
        await Promise.all([
          synthesizeHealth({ orgId, accountId, db }),
          db.from('usage_history')
            .select('active_users, licensed_seats, dau, mau, features_used_count, total_features, sessions_last_30d, product_usage, recorded_at')
            .eq('account_id', accountId).eq('org_id', orgId)
            .order('recorded_at', { ascending: false }).limit(1)
            .maybeSingle(),
          db.from('health_history')
            .select('score, recorded_at')
            .eq('account_id', accountId).eq('org_id', orgId)
            .gte('recorded_at', since90)
            .order('recorded_at', { ascending: true }),
          db.from('ces_history')
            .select('value, recorded_at')
            .eq('account_id', accountId).eq('org_id', orgId)
            .gte('recorded_at', since90)
            .order('recorded_at', { ascending: true }),
        ]);

      // 90-day direction — first vs last, computed in JS; model must not redo this
      let healthDir = null;
      if (healthHist && healthHist.length >= 2) {
        const delta = healthHist[healthHist.length - 1].score - healthHist[0].score;
        healthDir = delta > 3
          ? `+${delta} (improving)` : delta < -3
          ? `${delta} (declining)` : `${delta >= 0 ? '+' : ''}${delta} (stable)`;
      }
      let cesDir = null;
      if (cesHist && cesHist.length >= 2) {
        const delta = +(cesHist[cesHist.length - 1].value - cesHist[0].value).toFixed(1);
        cesDir = delta > 0.1
          ? `+${delta} (improving)` : delta < -0.1
          ? `${delta} (declining)` : `${delta >= 0 ? '+' : ''}${delta} (stable)`;
      }

      return {
        synthesis,
        usage: usageRow || null,
        healthDir,
        healthHistCount: (healthHist || []).length,
        cesDir,
        cesHistCount: (cesHist || []).length,
      };
    },
    render({ synthesis, usage, healthDir, healthHistCount, cesDir, cesHistCount }, { now }) {
      const lines = [];
      if (synthesis) {
        const net = synthesis.momentum.net;
        lines.push(`Health: ${synthesis.score ?? 'unknown'}/100 | Trend: ${synthesis.trend} | Momentum: ${synthesis.momentum.label} (net ${net >= 0 ? '+' : ''}${net}, ${synthesis.momentum.signal_count} signals)`);
        if (synthesis.recent_signals.length) {
          lines.push('Recent health signals:');
          for (const s of synthesis.recent_signals.slice(0, 3)) {
            lines.push(`  ${fmtDate(s.occurred_at, now)} — ${s.direction}/${s.magnitude}: ${trunc(s.rationale || '', 120)}`);
          }
        }
      } else {
        lines.push('Health synthesis unavailable.');
      }

      if (healthDir && healthHistCount >= 2) lines.push(`Health 90d direction: ${healthDir} (${healthHistCount} readings)`);
      if (cesDir   && cesHistCount   >= 2) lines.push(`CES 90d direction: ${cesDir} (${cesHistCount} readings)`);

      if (usage) {
        lines.push(`\nUsage snapshot (${fmtDate(usage.recorded_at, now)}):`);
        if (usage.active_users != null && usage.licensed_seats != null)
          lines.push(`  Seats: ${usage.active_users}/${usage.licensed_seats} adopted`);
        if (usage.dau != null && usage.mau != null) {
          const ratio = usage.mau > 0 ? ` (${Math.round(usage.dau / usage.mau * 100)}%)` : '';
          lines.push(`  DAU/MAU: ${usage.dau}/${usage.mau}${ratio}`);
        }
        if (usage.features_used_count != null && usage.total_features != null)
          lines.push(`  Feature breadth: ${usage.features_used_count}/${usage.total_features}`);
        if (usage.sessions_last_30d != null)
          lines.push(`  Sessions (30d): ${usage.sessions_last_30d}`);
        lines.push(`  Usage score: ${usage.product_usage ?? 'unknown'}`);
      }
      return lines.join('\n');
    },
  },

  // ── 6. voice_of_customer ─────────────────────────────────────────────────────
  {
    name: 'voice_of_customer',
    budget: 4000,
    async gather({ orgId, accountId, db }) {
      // Survey responses are not account-scoped — join through surveys
      const { data: accountSurveys } = await db.from('surveys')
        .select('id, type')
        .eq('account_id', accountId).eq('org_id', orgId);

      const surveyIds = (accountSurveys || []).map(s => s.id);
      let surveyResponses = [];
      if (surveyIds.length) {
        const { data: responses } = await db.from('survey_responses')
          .select('survey_id, score, custom_answer, submitted_at')
          .in('survey_id', surveyIds)
          .order('submitted_at', { ascending: false })
          .limit(10);
        const typeById = Object.fromEntries((accountSurveys || []).map(s => [s.id, s.type]));
        surveyResponses = (responses || []).map(r => ({
          type:         typeById[r.survey_id] || 'survey',
          score:        r.score,
          custom_answer: r.custom_answer,
          submitted_at: r.submitted_at,
        }));
      }

      const [
        { data: meetings },
        { data: interactions },
        { data: unreadThreads },
      ] = await Promise.all([
        db.from('meeting_notes')
          .select('title, meeting_date, summary, action_items')
          .eq('account_id', accountId).eq('org_id', orgId)
          .order('meeting_date', { ascending: false }).limit(5),
        db.from('interactions')
          .select('source, direction, occurred_at, content, summary')
          .eq('account_id', accountId).eq('org_id', orgId)
          .order('occurred_at', { ascending: false }).limit(10),
        db.from('email_threads')
          .select('subject, last_message_at')
          .eq('account_id', accountId).eq('org_id', orgId)
          .eq('is_unread_reply', true)
          .order('last_message_at', { ascending: false }),
      ]);

      return {
        surveyResponses,
        meetings:     meetings      || [],
        interactions: interactions  || [],
        unreadThreads: unreadThreads || [],
      };
    },
    render({ surveyResponses, meetings, interactions, unreadThreads }, { now }) {
      const lines = [];

      if (surveyResponses.length) {
        lines.push(`Survey responses (${surveyResponses.length}):`);
        for (const r of surveyResponses) {
          const ans = r.custom_answer ? ` — "${trunc(r.custom_answer, 200)}"` : '';
          lines.push(`  ${fmtDate(r.submitted_at, now)} | ${r.type} score: ${r.score}${ans}`);
        }
        lines.push('');
      }

      if (unreadThreads.length) {
        lines.push(`Awaiting CSM reply — unanswered email threads (${unreadThreads.length}):`);
        for (const t of unreadThreads)
          lines.push(`  ${fmtDate(t.last_message_at, now)} | ${t.subject || '(no subject)'}`);
        lines.push('');
      }

      if (meetings.length) {
        lines.push(`Meeting notes (${meetings.length}):`);
        for (const m of meetings) {
          lines.push(`  ${fmtDate(m.meeting_date, now)} | ${m.title || 'Untitled'}`);
          if (m.summary)      lines.push(`    Summary: ${trunc(m.summary, 400)}`);
          if (m.action_items) lines.push(`    Actions: ${trunc(m.action_items, 200)}`);
        }
        lines.push('');
      }

      if (interactions.length) {
        lines.push(`Interactions (${interactions.length}):`);
        for (const i of interactions) {
          const dir  = i.direction ? ` [${i.direction}]` : '';
          const body = trunc(i.summary || i.content || '', 300);
          lines.push(`  ${fmtDate(i.occurred_at, now)} | ${i.source}${dir}: ${body}`);
        }
      }

      return lines.join('\n').trim() || 'No customer voice data found.';
    },
  },

  // ── 7. support ───────────────────────────────────────────────────────────────
  {
    name: 'support',
    budget: 1200,
    async gather({ orgId, accountId, db }) {
      const { data } = await db.from('tickets')
        .select('subject, priority, opened_at, is_open')
        .eq('account_id', accountId).eq('org_id', orgId).eq('is_open', true)
        .order('opened_at', { ascending: true }).limit(15);
      return { tickets: data || [] };
    },
    render({ tickets }, { now }) {
      if (!tickets.length) return 'No open support tickets.';
      const lines = [`Open tickets (${tickets.length}):`];
      for (const t of tickets) {
        const ageMs   = t.opened_at ? now.getTime() - new Date(t.opened_at).getTime() : NaN;
        const ageDays = isNaN(ageMs) ? null : Math.round(ageMs / 86400000);
        const ageStr  = ageDays != null ? ` — ${ageDays}d open` : '';
        lines.push(`  [${t.priority || 'normal'}] ${t.subject || '(no subject)'}${ageStr} (opened ${fmtDate(t.opened_at, now)})`);
      }
      return lines.join('\n');
    },
  },

  // ── 8. history ───────────────────────────────────────────────────────────────
  {
    name: 'history',
    budget: 1800,
    async gather({ orgId, accountId, db }) {
      const [
        { data: churnEvents },
        { data: accountRow },
        { data: automationLog },
        { data: activityLog },
      ] = await Promise.all([
        db.from('churn_events')
          .select('account_name, arr, reason, notes, churned_at')
          .eq('account_id', accountId).eq('org_id', orgId),
        db.from('accounts')
          .select('escalation_summary')
          .eq('id', accountId).eq('org_id', orgId).maybeSingle(),
        db.from('automation_log')
          .select('rule_name, action_type, detail, fired_at')
          .eq('account_id', accountId).eq('org_id', orgId)
          .order('fired_at', { ascending: false }).limit(10),
        db.from('activity_log')
          .select('type, note, logged_at')
          .eq('account_id', accountId).eq('org_id', orgId)
          .order('logged_at', { ascending: false }).limit(10),
      ]);
      return {
        churnEvents:       churnEvents    || [],
        escalationSummary: accountRow?.escalation_summary || null,
        automationLog:     automationLog  || [],
        activityLog:       activityLog    || [],
      };
    },
    render({ churnEvents, escalationSummary, automationLog, activityLog }, { now }) {
      const lines = [];

      if (churnEvents.length) {
        lines.push(`Churn events (${churnEvents.length}):`);
        for (const e of churnEvents) {
          const arr = e.arr != null ? `$${Number(e.arr).toLocaleString()}` : 'unknown ARR';
          lines.push(`  ${fmtDate(e.churned_at, now)} | ${arr} | ${e.reason}${e.notes ? ` — ${e.notes}` : ''}`);
        }
        lines.push('');
      }

      if (escalationSummary) {
        lines.push('Escalation brief (cached):');
        if (escalationSummary.situation)
          lines.push(`  ${escalationSummary.situation}`);
        if (Array.isArray(escalationSummary.challenges) && escalationSummary.challenges.length)
          lines.push(`  Challenges: ${escalationSummary.challenges.join('; ')}`);
        lines.push('');
      }

      if (automationLog.length) {
        lines.push(`Automation events (${automationLog.length}):`);
        for (const a of automationLog)
          lines.push(`  ${fmtDate(a.fired_at, now)} | [${a.action_type}] ${a.rule_name || 'rule'}${a.detail ? `: ${a.detail}` : ''}`);
        lines.push('');
      }

      if (activityLog.length) {
        lines.push(`Activity log (${activityLog.length}):`);
        for (const a of activityLog)
          lines.push(`  ${fmtDate(a.logged_at, now)} | [${a.type}]${a.note ? ` ${a.note}` : ''}`);
      }

      return lines.join('\n').trim() || 'No historical events.';
    },
  },

  // ── 9. opportunities ─────────────────────────────────────────────────────────
  {
    name: 'opportunities',
    budget: 1200,
    async gather({ orgId, accountId, db }) {
      const matches = await matchOpportunities({ orgId, accountId, db });
      return { matches: matches || [] };
    },
    render({ matches }) {
      if (!matches.length) return 'No upsell opportunities matched.';
      return matches.map(m => {
        const tier    = m.tier ? ` [${m.tier}]` : '';
        const kw      = m.matchedKeywords.join(', ');
        const snippet = m.evidence[0]?.snippet || '(no snippet)';
        return `${m.featureName}${tier}\n  Keywords: ${kw}\n  Evidence: ${snippet}`;
      }).join('\n\n');
    },
  },

  // ── 10. product_knowledge ────────────────────────────────────────────────────
  {
    name: 'product_knowledge',
    budget: 2000,
    async gather({ orgId, db, options }) {
      if (options.includeProductKnowledge === false) return null;
      const [{ data: profile }, { data: features }] = await Promise.all([
        db.from('company_profile')
          .select('product_name, website_url, overview, icp, positioning, confirmed, generated_at')
          .eq('org_id', orgId).maybeSingle(),
        db.from('features')
          .select('name, problem_solved, tier')
          .eq('org_id', orgId).limit(15),
      ]);
      return { profile: profile || null, features: features || [] };
    },
    render(data, { now }) {
      if (!data) return null; // options.includeProductKnowledge === false
      const { profile, features } = data;
      if (!profile) return 'No product knowledge configured.';
      const lines = [
        `Product: ${profile.product_name || 'unknown'}${profile.website_url ? ` | ${profile.website_url}` : ''}`,
        `Status: ${profile.confirmed ? 'confirmed' : 'draft'} | Generated: ${fmtDate(profile.generated_at, now)}`,
      ];
      if (profile.overview)    lines.push(`\nOverview: ${trunc(profile.overview, 400)}`);
      if (profile.icp)         lines.push(`ICP: ${trunc(profile.icp, 300)}`);
      if (profile.positioning) lines.push(`Positioning: ${trunc(profile.positioning, 200)}`);
      if (features.length) {
        lines.push(`\nFeatures (${features.length}):`);
        for (const f of features) {
          const tier = f.tier ? ` [${f.tier}]` : '';
          const prob = f.problem_solved ? ` — ${f.problem_solved}` : '';
          lines.push(`  ${f.name}${tier}${prob}`);
        }
      }
      return lines.join('\n');
    },
  },

  // ── 11. semantic_context ──────────────────────────────────────────────────────
  {
    name: 'semantic_context',
    budget: 2500,
    async gather({ orgId, accountId, userId, options }) {
      if (!options.query) return null;
      const result = await getContext(options.query, {
        orgId,
        accountId,
        limit:     options.semanticLimit || 10,
        createdBy: userId,
      });
      return { interactions: result.interactions || [] };
    },
    render(data, { now }) {
      if (!data) return null; // no query provided
      const { interactions } = data;
      if (!interactions.length) return 'No relevant context found for query.';
      return interactions.map((item, idx) => {
        const dir   = item.direction ? ` [${item.direction}]` : '';
        const label = `[${idx + 1}] ${fmtDate(item.occurred_at, now)} | ${item.source}${dir}`;
        const body  = trunc(item.summary || item.content || '', 500);
        return `${label}:\n${body}`;
      }).join('\n\n');
    },
  },
];

// Sections trimmed first when global cap is exceeded (lowest → highest priority)
const GLOBAL_TRIM_ORDER = ['semantic_context', 'product_knowledge', 'history', 'voice_of_customer'];

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function buildAccountContext({ orgId, accountId, userId, db: dbArg, options = {} }) {
  const db           = dbArg || defaultSupabase;
  const maxTotalChars = options.maxTotalChars ?? 18000;
  const now          = new Date(); // single NOW for all date rendering this call

  // Select which sections to run (options.sections = array of names)
  const wantNames = options.sections
    ? new Set(options.sections.filter(n => SECTIONS.some(s => s.name === n)))
    : new Set(SECTIONS.map(s => s.name));

  const active = SECTIONS.filter(s => wantNames.has(s.name));
  const ctx    = { orgId, accountId, userId, db, options, now };

  const t0 = Date.now();

  // Run all gathers in parallel; each is wrapped so one failure cannot kill the build
  const gathered = await Promise.all(
    active.map(async (section) => {
      try {
        const data = await section.gather(ctx);
        return { name: section.name, data, err: null };
      } catch (e) {
        console.error(`[accountContext] ${section.name} gather failed:`, e.message);
        return { name: section.name, data: null, err: e.message };
      }
    })
  );

  const gatherMs = Date.now() - t0;

  // Render each section and apply its per-section budget
  const sectionMeta  = {}; // name → { text, available, truncated, itemCounts }
  const sectionTexts = {}; // name → string | null (null = excluded from output)

  for (let i = 0; i < active.length; i++) {
    const section = active[i];
    const { data, err } = gathered[i];
    const budget = options.budgets?.[section.name] != null
      ? options.budgets[section.name]
      : section.budget;

    // Gather error → unavailable
    if (err) {
      sectionMeta[section.name]  = { text: '', available: false, truncated: false, itemCounts: {} };
      sectionTexts[section.name] = null;
      continue;
    }

    // null from gather → intentionally excluded (semantic_context with no query, etc.)
    if (data === null) {
      sectionMeta[section.name]  = { text: '', available: false, truncated: false, itemCounts: {} };
      sectionTexts[section.name] = null;
      continue;
    }

    let rawText;
    try {
      rawText = section.render(data, ctx);
    } catch (renderErr) {
      console.error(`[accountContext] ${section.name} render failed:`, renderErr.message);
      sectionMeta[section.name]  = { text: '', available: false, truncated: false, itemCounts: {} };
      sectionTexts[section.name] = null;
      continue;
    }

    // null from render → intentionally excluded
    if (rawText == null) {
      sectionMeta[section.name]  = { text: '', available: false, truncated: false, itemCounts: {} };
      sectionTexts[section.name] = null;
      continue;
    }

    const { out, truncated } = applyBudget(rawText, budget);
    sectionMeta[section.name]  = { text: out, available: true, truncated, itemCounts: computeItemCounts(data) };
    sectionTexts[section.name] = out;
  }

  // Global cap: trim sections in reverse priority order; 'profile' is never trimmed
  let total = Object.values(sectionTexts).reduce((s, t) => s + (t ? t.length : 0), 0);

  if (total > maxTotalChars) {
    for (const name of GLOBAL_TRIM_ORDER) {
      if (total <= maxTotalChars) break;
      const current = sectionTexts[name];
      if (!current) continue;
      const currentLen = current.length;
      const need       = total - maxTotalChars;
      if (currentLen <= need + 20) {
        // Remove section entirely
        total -= currentLen;
        sectionTexts[name]              = '';
        sectionMeta[name].text          = '';
        sectionMeta[name].truncated     = true;
      } else {
        // Partial trim
        const newLen = currentLen - need;
        let cut = current.lastIndexOf(' ', newLen);
        if (cut <= 0) cut = newLen;
        const trimmed = current.slice(0, cut) + '…[truncated]';
        total = total - currentLen + trimmed.length;
        sectionTexts[name]          = trimmed;
        sectionMeta[name].text      = trimmed;
        sectionMeta[name].truncated = true;
      }
    }
  }

  // Assemble final text with ## SECTION_NAME headers
  const blocks = active
    .filter(s => sectionTexts[s.name] != null && sectionTexts[s.name] !== '')
    .map(s => `## ${s.name.toUpperCase().replace(/_/g, ' ')}\n${sectionTexts[s.name]}`);

  const text       = blocks.join('\n\n');
  const totalChars = text.length;

  // Build citations from semantic_context markers that survive the final text
  let citations   = [];
  let citationIds = [];

  const scEntry = gathered.find(g => g.name === 'semantic_context');
  if (scEntry && scEntry.data && Array.isArray(scEntry.data.interactions)) {
    const finalScText = sectionTexts['semantic_context'] || '';
    scEntry.data.interactions.forEach((item, idx) => {
      const marker = `[${idx + 1}]`;
      if (finalScText.includes(marker)) {
        citations.push({
          marker,
          id:          item.id,
          source:      item.source,
          occurred_at: item.occurred_at,
          snippet:     trunc(item.summary || item.content || '', 180),
        });
        citationIds.push(item.id);
      }
    });
  }

  return {
    text,
    sections: sectionMeta,
    stats: { totalChars, gatherMs },
    citations,
    citationIds,
  };
}

module.exports = { buildAccountContext };
