'use strict';

const DAYS_90 = 90 * 24 * 60 * 60 * 1000;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKeywordRegex(keyword) {
  const tokens = keyword.trim().split(/[\s\-]+/).filter(Boolean);
  const pattern = tokens.map(escapeRegex).join('[\\s\\-]+');
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

function extractSnippet(text, matchIndex, matchLength) {
  const RADIUS = 90;
  let start = Math.max(0, matchIndex - RADIUS);
  let end = Math.min(text.length, matchIndex + matchLength + RADIUS);

  if (start > 0) {
    const spaceIdx = text.indexOf(' ', start);
    if (spaceIdx !== -1 && spaceIdx < matchIndex) start = spaceIdx + 1;
  }
  if (end < text.length) {
    const spaceIdx = text.lastIndexOf(' ', end);
    if (spaceIdx !== -1 && spaceIdx > matchIndex + matchLength) end = spaceIdx;
  }

  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

async function matchOpportunities({ orgId, accountId, db }) {
  // 1. Verify account exists and belongs to orgId
  const { data: acct } = await db.from('accounts')
    .select('id')
    .eq('id', accountId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!acct) return null;

  const cutoff = new Date(Date.now() - DAYS_90).toISOString();
  const textItems = [];

  // 2a. Interactions — content and summary are separate text items per row
  const { data: interactions } = await db.from('interactions')
    .select('id, content, summary, occurred_at, created_at')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .gte('occurred_at', cutoff)
    .order('occurred_at', { ascending: false })
    .limit(30);

  for (const row of (interactions || [])) {
    const ts = row.occurred_at || row.created_at;
    if (row.content && row.content.trim()) {
      textItems.push({ source: 'interaction', sourceId: row.id, sourceTitle: null, occurredAt: ts, text: row.content });
    }
    if (row.summary && row.summary.trim()) {
      textItems.push({ source: 'interaction', sourceId: row.id, sourceTitle: null, occurredAt: ts, text: row.summary });
    }
  }

  // 2b. Meeting notes — title + summary + action_items concatenated per row
  const { data: meetings } = await db.from('meeting_notes')
    .select('id, title, summary, action_items, meeting_date')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .gte('meeting_date', cutoff)
    .order('meeting_date', { ascending: false })
    .limit(30);

  for (const row of (meetings || [])) {
    const parts = [row.title, row.summary, row.action_items].filter(Boolean);
    if (parts.length) {
      textItems.push({
        source: 'meeting_note',
        sourceId: row.id,
        sourceTitle: row.title || null,
        occurredAt: row.meeting_date,
        text: parts.join('\n'),
      });
    }
  }

  // 2c. Email threads — subject + snippet concatenated
  const { data: emails } = await db.from('email_threads')
    .select('id, subject, snippet, last_message_at')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .gte('last_message_at', cutoff)
    .order('last_message_at', { ascending: false })
    .limit(30);

  for (const row of (emails || [])) {
    const parts = [row.subject, row.snippet].filter(Boolean);
    if (parts.length) {
      textItems.push({
        source: 'email',
        sourceId: row.id,
        sourceTitle: row.subject || null,
        occurredAt: row.last_message_at,
        text: parts.join(' '),
      });
    }
  }

  // 2d. Tickets — subject only
  const { data: tickets } = await db.from('tickets')
    .select('id, subject, opened_at')
    .eq('account_id', accountId)
    .eq('org_id', orgId)
    .gte('opened_at', cutoff)
    .order('opened_at', { ascending: false })
    .limit(30);

  for (const row of (tickets || [])) {
    if (row.subject && row.subject.trim()) {
      textItems.push({
        source: 'ticket',
        sourceId: row.id,
        sourceTitle: row.subject || null,
        occurredAt: row.opened_at,
        text: row.subject,
      });
    }
  }

  // 3. Features with non-empty trigger_keywords (filter in JS — jsonb array)
  const { data: allFeatures } = await db.from('features')
    .select('id, name, problem_solved, tier, trigger_keywords')
    .eq('org_id', orgId);

  const activeFeatures = (allFeatures || []).filter(
    f => Array.isArray(f.trigger_keywords) && f.trigger_keywords.length > 0
  );

  // Exclude dismissed features
  const { data: dismissals } = await db.from('opportunity_dismissals')
    .select('feature_id')
    .eq('account_id', accountId);

  const dismissedIds = new Set((dismissals || []).map(d => d.feature_id));
  const candidateFeatures = activeFeatures.filter(f => !dismissedIds.has(f.id));

  // 4. Match per feature × keyword × text item
  const results = [];

  for (const feature of candidateFeatures) {
    const evidenceMap = new Map(); // key: `${sourceId}:${keyword}` — dedupe

    for (const keyword of feature.trigger_keywords) {
      if (!keyword || keyword.trim().length < 3) continue;

      const regex = buildKeywordRegex(keyword);

      for (const item of textItems) {
        const match = regex.exec(item.text);
        if (!match) continue;

        const key = `${item.sourceId}:${keyword}`;
        if (evidenceMap.has(key)) continue;

        evidenceMap.set(key, {
          source: item.source,
          sourceId: item.sourceId,
          sourceTitle: item.sourceTitle,
          occurredAt: item.occurredAt,
          keyword,
          snippet: extractSnippet(item.text, match.index, match[0].length),
        });
      }
    }

    if (evidenceMap.size === 0) continue;

    const allEvidence = Array.from(evidenceMap.values());
    const matchedKeywords = [...new Set(allEvidence.map(e => e.keyword))];

    const evidence = allEvidence
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
      .slice(0, 3);

    results.push({
      featureId: feature.id,
      featureName: feature.name,
      problemSolved: feature.problem_solved,
      tier: feature.tier,
      matchedKeywords,
      evidence,
    });
  }

  // Sort by distinct-keyword count desc, then newest evidence first
  results.sort((a, b) => {
    if (b.matchedKeywords.length !== a.matchedKeywords.length) {
      return b.matchedKeywords.length - a.matchedKeywords.length;
    }
    const aLatest = a.evidence[0]?.occurredAt || '';
    const bLatest = b.evidence[0]?.occurredAt || '';
    return bLatest.localeCompare(aLatest);
  });

  return results;
}

module.exports = { matchOpportunities };
