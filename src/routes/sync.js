/**
 * Sync routes — all integration configs and sync operations scoped to req.userId.
 * Each CSM has their own integration connections — Ahmed's HubSpot credentials
 * are completely separate from Sara's.
 */

const express  = require("express");
const supabase = require("../supabase");
const { CONNECTORS } = require("../connectors");
const { calcHealth  } = require("../health");

const router = express.Router();

// ── GET /api/sync/status ──────────────────────────────────────────────────────
router.get("/status", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("integrations").select("*").eq("user_id", req.userId);
    if (error) throw error;
    res.json({ integrations: data || [] });
  } catch (err) { next(err); }
});

// ── POST /api/sync/configure ──────────────────────────────────────────────────
router.post("/configure", async (req, res, next) => {
  try {
    const { connectorId, credentials, fieldMap, connected } = req.body;
    if (!connectorId) return res.status(400).json({ error: "connectorId is required" });

    const { error } = await supabase.from("integrations").upsert({
      user_id:      req.userId,
      connector_id: connectorId,
      credentials:  credentials || {},
      field_map:    fieldMap    || {},
      connected:    connected   ?? false,
      updated_at:   new Date().toISOString(),
    }, { onConflict: "user_id,connector_id" });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/sync/test ───────────────────────────────────────────────────────
router.post("/test", async (req, res, next) => {
  try {
    const { connectorId, credentials } = req.body;
    const connector = CONNECTORS[connectorId];
    if (!connector) return res.status(400).json({ error: `Unknown connector: ${connectorId}` });

    await connector(credentials, {}).catch(err => {
      throw new Error(`Connection failed: ${err.response?.data?.message || err.message}`);
    });

    res.json({ success: true, message: "Connection verified" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/sync/run ────────────────────────────────────────────────────────
router.post("/run", async (req, res, next) => {
  try {
    const { connectorId } = req.body;
    if (!connectorId) return res.status(400).json({ error: "connectorId is required" });

    const { data: integration, error: fetchErr } = await supabase
      .from("integrations").select("*")
      .eq("user_id", req.userId).eq("connector_id", connectorId).single();

    if (fetchErr || !integration) {
      return res.status(404).json({ error: `Integration not found: ${connectorId}` });
    }
    if (!integration.connected) {
      return res.status(400).json({ error: `Integration ${connectorId} is not connected` });
    }

    const connector = CONNECTORS[connectorId];
    if (!connector) return res.status(400).json({ error: `Unknown connector: ${connectorId}` });

    const startedAt = new Date().toISOString();
    let created = 0, updated = 0, skipped = 0;
    const errors = [];

    const creds = integration.oauth_token
      ? { ...integration.credentials, accessToken: integration.oauth_token }
      : integration.credentials;

    const records = await connector(creds, integration.field_map || {});

    for (const record of records) {
      try {
        const { data: existing } = await supabase
          .from("accounts").select("id, open_tickets, last_contact")
          .eq("user_id", req.userId)
          .eq("external_id", record.externalId)
          .eq("source", record.source)
          .maybeSingle();

        const { healthScore, churnRisk, stage } = calcHealth({
          nps: record.nps || 50, ces: record.ces || 3.5,
          productUsage: record.productUsage || 60,
          openTickets:  record.openTickets  || 0,
        });

        const row = {
          user_id:      req.userId,
          name:         record.name,
          industry:     record.industry || "",
          arr:          record.arr || 0,
          renewal_date: record.renewalDate || null,
          open_tickets: record.openTickets || 0,
          last_contact: record.lastContact || new Date().toISOString().split("T")[0],
          notes:        record.notes || null,
          health_score: healthScore,
          churn_risk:   churnRisk,
          stage,
          source:       record.source,
          external_id:  record.externalId,
        };

        if (existing) {
          if (existing.open_tickets !== record.openTickets
            || existing.last_contact !== record.lastContact) {
            await supabase.from("accounts").update(row)
              .eq("id", existing.id).eq("user_id", req.userId);
            updated++;
          } else {
            skipped++;
          }
        } else {
          await supabase.from("accounts").insert(row);
          created++;
        }
      } catch (e) {
        errors.push(`"${record.name}": ${e.message}`);
        skipped++;
      }
    }

    // Update integration record
    await supabase.from("integrations").update({
      last_sync:  new Date().toISOString(),
      sync_count: (integration.sync_count || 0) + created + updated,
    }).eq("user_id", req.userId).eq("connector_id", connectorId);

    // Write sync log
    await supabase.from("sync_log").insert({
      user_id:         req.userId,
      connector_id:    connectorId,
      status:          errors.length > 0 && created + updated === 0 ? "error" : "success",
      records_created: created,
      records_updated: updated,
      records_skipped: skipped,
      error_message:   errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
      started_at:      startedAt,
      finished_at:     new Date().toISOString(),
    });

    res.json({ success: true, created, updated, skipped, errors: errors.slice(0, 5) });
  } catch (err) { next(err); }
});

// ── GET /api/sync/log/:connectorId ────────────────────────────────────────────
router.get("/log/:connectorId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("sync_log").select("*")
      .eq("user_id", req.userId).eq("connector_id", req.params.connectorId)
      .order("started_at", { ascending: false }).limit(10);

    if (error) throw error;
    res.json({ log: data || [] });
  } catch (err) { next(err); }
});

module.exports = router;
