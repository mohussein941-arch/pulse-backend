/**
 * Tickets analysis — shared reader over the `tickets` table.
 * Used by the escalation case-summary generator and the account tickets route.
 *
 * Only the connectors that emit individual tickets (zendesk, freshdesk,
 * hubspot_service) populate this table; for other accounts `open` will be
 * empty even when accounts.open_tickets is a non-zero count. Callers that need
 * to reconcile should fall back to accounts.open_tickets themselves.
 */
const defaultSupabase = require("../supabase");

// Normalized priority vocabulary emitted by all three connectors.
const PRIORITY_RANK = { urgent: 4, high: 3, normal: 2, low: 1 };
const CRITICAL_PRIORITIES = new Set(["high", "urgent"]);
const AGEING_DAYS = 7; // an open ticket older than this is "ageing"

function ageInDays(openedAt, now) {
  if (!openedAt) return null;
  const ms = now - new Date(openedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86400000);
}

/**
 * Fetch open tickets for an account and derive analysis.
 * @returns {{ open: object[], critical: object[], ageing: object[],
 *             counts: { open: number, critical: number, ageing: number } }}
 */
async function getAccountTickets({ orgId, accountId, db = defaultSupabase, now = Date.now() }) {
  const { data, error } = await db
    .from("tickets")
    .select("external_id, subject, status, priority, opened_at, ticket_updated_at, url, is_open")
    .eq("org_id", orgId)
    .eq("account_id", accountId)
    .eq("is_open", true);
  if (error) throw error;

  const open = (data || []).map((t) => {
    const priority = (t.priority || "normal").toLowerCase();
    const age = ageInDays(t.opened_at, now);
    return {
      externalId: t.external_id,
      subject:    t.subject || "(no subject)",
      status:     t.status || null,
      priority,
      openedAt:   t.opened_at || null,
      updatedAt:  t.ticket_updated_at || null,
      url:        t.url || null,
      ageDays:    age,
      isCritical: CRITICAL_PRIORITIES.has(priority),
      isAgeing:   age != null && age > AGEING_DAYS,
    };
  });

  // Most urgent first, then oldest first within a priority.
  open.sort((a, b) =>
    (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
    || (b.ageDays ?? -1) - (a.ageDays ?? -1)
  );

  const critical = open.filter((t) => t.isCritical);
  const ageing   = open.filter((t) => t.isAgeing);

  return {
    open,
    critical,
    ageing,
    counts: { open: open.length, critical: critical.length, ageing: ageing.length },
  };
}

module.exports = { getAccountTickets, AGEING_DAYS, PRIORITY_RANK, CRITICAL_PRIORITIES };
