const axios   = require("axios");
const supabase = require("../supabase");
const { decrypt } = require("../utils/crypto");
const { getEncoding } = require("js-tiktoken");
const { writeInteraction } = require("../services/context-engine/ingestion");

const FIREFLIES_GQL    = "https://api.fireflies.ai/graphql";
const MAX_BODY_TOKENS  = 8_000;

// Fetches up to 50 transcripts including full sentence-level content.
// 50 is conservative to keep the GraphQL response size manageable;
// pagination can be added if orgs accumulate > 50 transcripts.
const TRANSCRIPTS_QUERY = `{
  transcripts(limit: 50) {
    id
    title
    date
    participants
    organizer_email
    summary { overview action_items }
    sentences { raw_words speaker_name }
  }
}`;

let enc = null;
function getEnc() {
  if (!enc) enc = getEncoding("cl100k_base");
  return enc;
}

function countTokens(text) {
  return getEnc().encode(text).length;
}

function truncateToTokens(text, maxTokens) {
  const tokenIds = getEnc().encode(text);
  if (tokenIds.length <= maxTokens) return text;
  const decoder = new TextDecoder();
  return decoder.decode(getEnc().decode(tokenIds.slice(0, maxTokens)));
}

// ── Build readable transcript body from sentences ─────────────────────────────
// Format: "[Speaker]: words" per speaker turn. Falls back to summary if empty.
function buildTranscriptContent(t) {
  const sentences = t.sentences || [];

  if (sentences.length > 0) {
    const lines = [];
    let lastSpeaker = null;
    let buffer = [];

    for (const s of sentences) {
      const speaker = s.speaker_name || "Unknown";
      if (speaker !== lastSpeaker) {
        if (lastSpeaker !== null) lines.push(`[${lastSpeaker}]: ${buffer.join(" ")}`);
        buffer = [s.raw_words];
        lastSpeaker = speaker;
      } else {
        buffer.push(s.raw_words);
      }
    }
    if (lastSpeaker !== null) lines.push(`[${lastSpeaker}]: ${buffer.join(" ")}`);

    const body = lines.join("\n");
    const tokens = countTokens(body);
    if (tokens > MAX_BODY_TOKENS) {
      const truncated = truncateToTokens(body, MAX_BODY_TOKENS);
      console.log(`[Fireflies Ingestion] truncated transcript ${t.id}: ${tokens} → ${MAX_BODY_TOKENS} tokens`);
      return truncated;
    }
    return body;
  }

  // Fall back to summary text when no sentences available
  const parts = [];
  if (t.summary?.overview) parts.push(t.summary.overview);
  if (t.summary?.action_items) {
    const items = Array.isArray(t.summary.action_items)
      ? t.summary.action_items.join("\n")
      : t.summary.action_items;
    parts.push("Action items:\n" + items);
  }
  return parts.join("\n\n") || null;
}

async function syncFirefliesForOrg(orgId) {
  const { data: integration } = await supabase
    .from("integrations")
    .select("credentials, connected, user_id")
    .eq("org_id", orgId)
    .eq("connector_id", "fireflies")
    .maybeSingle();

  if (!integration?.connected) return { synced: 0, matched: 0 };

  const apiKey  = decrypt(integration.credentials.apiKey);
  const userId  = integration.user_id;

  const res = await axios.post(
    FIREFLIES_GQL,
    { query: TRANSCRIPTS_QUERY },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  if (res.data?.errors?.length) {
    throw new Error(res.data.errors[0]?.message || "Fireflies API error");
  }

  const transcripts = res.data?.data?.transcripts || [];

  // Build stakeholder email → account_id lookup (org-scoped)
  const { data: stakeholders } = await supabase
    .from("stakeholders")
    .select("email, account_id")
    .eq("org_id", orgId)
    .not("email", "is", null);

  const emailMap = new Map();
  for (const s of (stakeholders || [])) {
    if (s.email) emailMap.set(s.email.toLowerCase(), s.account_id);
  }

  // Build account domain → account_id lookup (org-scoped)
  const { data: accounts } = await supabase
    .from("accounts")
    .select("id, domain, last_contact")
    .eq("org_id", orgId)
    .not("domain", "is", null);

  const domainMap      = new Map();
  const lastContactMap = new Map();
  for (const a of (accounts || [])) {
    if (a.domain) domainMap.set(a.domain.toLowerCase(), a.id);
    lastContactMap.set(a.id, a.last_contact);
  }

  let synced = 0, matched = 0;

  for (const t of transcripts) {
    let accountId = null;

    for (const email of (t.participants || [])) {
      const emailLower = email.toLowerCase();
      if (emailMap.has(emailLower)) { accountId = emailMap.get(emailLower); break; }
    }

    if (!accountId) {
      for (const email of (t.participants || [])) {
        const domain = email.split("@")[1]?.toLowerCase();
        if (domain && domainMap.has(domain)) { accountId = domainMap.get(domain); break; }
      }
    }

    const meetingDate = t.date ? new Date(t.date * 1000).toISOString() : null;
    const actionItems = Array.isArray(t.summary?.action_items)
      ? t.summary.action_items.join("\n")
      : (t.summary?.action_items || null);

    // ── Legacy meeting_notes upsert (preserved for UI consumers) ─────────────
    await supabase.from("meeting_notes").upsert({
      user_id:         userId,
      org_id:          orgId,
      account_id:      accountId,
      fireflies_id:    t.id,
      title:           t.title || "Untitled meeting",
      meeting_date:    meetingDate,
      participants:    t.participants || [],
      summary:         t.summary?.overview || null,
      action_items:    actionItems,
      organizer_email: t.organizer_email || null,
      synced_at:       new Date().toISOString(),
    }, { onConflict: "org_id,fireflies_id" });

    // ── interactions write (M2a) ──────────────────────────────────────────────
    if (accountId) {
      const content = buildTranscriptContent(t);

      await writeInteraction({
        orgId,
        accountId,
        source:     "call_transcript",
        direction:  "internal",
        content,
        externalId: `fireflies:${t.id}`,
        timestamp:  meetingDate || new Date().toISOString(),
        createdBy:  userId,
        metadata: {
          title:           t.title || "Untitled meeting",
          participants:    t.participants || [],
          organizer_email: t.organizer_email || null,
          action_items:    actionItems,
          fireflies_id:    t.id,
        },
      });
    }

    // ── Activity log (deduped via external_ref) ───────────────────────────────
    if (accountId) {
      await supabase.from("activity_log").upsert({
        user_id:      userId,
        org_id:       orgId,
        account_id:   accountId,
        type:         "Meeting",
        source:       "fireflies_auto",
        external_ref: `fireflies:${t.id}`,
        note:         t.title || "Meeting synced from Fireflies",
        logged_at:    meetingDate ? meetingDate.split("T")[0] : new Date().toISOString().split("T")[0],
      }, { onConflict: "user_id,external_ref", ignoreDuplicates: true });
    }

    synced++;
    if (accountId) {
      matched++;
      if (meetingDate) {
        const meetingDay = meetingDate.slice(0, 10);
        const stored     = lastContactMap.get(accountId);
        if (!stored || meetingDay > stored) {
          await supabase.from("accounts")
            .update({ last_contact: meetingDay })
            .eq("id", accountId).eq("org_id", orgId);
          lastContactMap.set(accountId, meetingDay);
        }
      }
    }
  }

  return { synced, matched };
}

async function runFirefliesSync() {
  const { data: rows } = await supabase
    .from("integrations")
    .select("org_id")
    .eq("connector_id", "fireflies")
    .eq("connected", true);

  for (const { org_id } of (rows || [])) {
    try {
      await syncFirefliesForOrg(org_id);
    } catch (e) {
      console.error(`[Fireflies] sync failed for org ${org_id}: ${e.message}`);
    }
  }
}

module.exports = { syncFirefliesForOrg, runFirefliesSync };
