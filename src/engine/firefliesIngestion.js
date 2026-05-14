const axios   = require("axios");
const supabase = require("../supabase");
const { decrypt } = require("../utils/crypto");

const FIREFLIES_GQL = "https://api.fireflies.ai/graphql";

const TRANSCRIPTS_QUERY = `{
  transcripts(limit: 200) {
    id
    title
    date
    participants
    organizer_email
    summary { overview action_items }
  }
}`;

async function syncFirefliesForUser(userId) {
  const { data: integration } = await supabase
    .from("integrations")
    .select("credentials, connected")
    .eq("user_id", userId)
    .eq("connector_id", "fireflies")
    .maybeSingle();

  if (!integration?.connected) return { synced: 0, matched: 0 };

  const apiKey = decrypt(integration.credentials.apiKey);

  const res = await axios.post(
    FIREFLIES_GQL,
    { query: TRANSCRIPTS_QUERY },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  if (res.data?.errors?.length) {
    throw new Error(res.data.errors[0]?.message || "Fireflies API error");
  }

  const transcripts = res.data?.data?.transcripts || [];

  // Build stakeholder email → account_id lookup
  const { data: stakeholders } = await supabase
    .from("stakeholders")
    .select("email, account_id")
    .eq("user_id", userId)
    .not("email", "is", null);

  const emailMap = new Map();
  for (const s of (stakeholders || [])) {
    if (s.email) emailMap.set(s.email.toLowerCase(), s.account_id);
  }

  // Build account domain → account_id lookup
  const { data: accounts } = await supabase
    .from("accounts")
    .select("id, domain, last_contact")
    .eq("user_id", userId)
    .not("domain", "is", null);

  const domainMap = new Map();
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

    await supabase.from("meeting_notes").upsert({
      user_id:        userId,
      account_id:     accountId,
      fireflies_id:   t.id,
      title:          t.title || "Untitled meeting",
      meeting_date:   meetingDate,
      participants:   t.participants || [],
      summary:        t.summary?.overview || null,
      action_items:   actionItems,
      organizer_email: t.organizer_email || null,
      synced_at:      new Date().toISOString(),
    }, { onConflict: "user_id,fireflies_id" });

    synced++;
    if (accountId) {
      matched++;
      // Update last_contact if this meeting is more recent
      if (meetingDate) {
        const meetingDay = meetingDate.slice(0, 10);
        const stored     = lastContactMap.get(accountId);
        if (!stored || meetingDay > stored) {
          await supabase.from("accounts")
            .update({ last_contact: meetingDay })
            .eq("id", accountId).eq("user_id", userId);
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
    .select("user_id")
    .eq("connector_id", "fireflies")
    .eq("connected", true);

  for (const { user_id } of (rows || [])) {
    try {
      await syncFirefliesForUser(user_id);
    } catch (e) {
      console.error(`[Fireflies] sync failed for ${user_id}: ${e.message}`);
    }
  }
}

module.exports = { syncFirefliesForUser, runFirefliesSync };
