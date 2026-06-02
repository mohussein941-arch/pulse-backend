/**
 * Sync routes — M0b: integrations scoped to req.orgId (one CRM per org).
 * Account writes also use org_id. Credential lookup (within run) still
 * validates by org to prevent cross-org credential access.
 */

const express  = require("express");
const supabase = require("../supabase");
const { CONNECTORS } = require("../connectors");
const { calcHealth  } = require("../health");
const { encrypt, decrypt } = require("../utils/crypto");
const { writeInteraction } = require("../services/context-engine/ingestion");

const router = express.Router();

const encryptCreds = creds => {
  const out = {};
  for (const [k, v] of Object.entries(creds || {})) {
    out[k] = v ? encrypt(String(v)) : null;
  }
  return out;
};

const decryptCreds = creds => {
  const out = {};
  for (const [k, v] of Object.entries(creds || {})) {
    out[k] = v ? decrypt(v) : null;
  }
  return out;
};

// ── GET /api/sync/status ──────────────────────────────────────────────────────
router.get("/status", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("integrations").select("*").eq("org_id", req.orgId);
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
      // user_id renamed to created_by in Phase 2 (Step 8); keep user_id until then
      user_id:      req.userId,
      org_id:       req.orgId,
      connector_id: connectorId,
      credentials:  encryptCreds(credentials || {}),
      field_map:    fieldMap    || {},
      connected:    connected   ?? false,
      updated_at:   new Date().toISOString(),
    }, { onConflict: "org_id,connector_id" });

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

    await connector(decryptCreds(credentials || {}), {}).catch(err => {
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

    // Fetch integration by org scope (Q1: one connector per org)
    const { data: integration, error: fetchErr } = await supabase
      .from("integrations").select("*")
      .eq("org_id", req.orgId).eq("connector_id", connectorId).single();

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

    const creds = decryptCreds(integration.credentials || {});

    const records = await connector(creds, integration.field_map || {});

    for (const record of records) {
      try {
        const { data: existing } = await supabase
          .from("accounts").select("id, open_tickets, last_contact")
          .eq("org_id", req.orgId)
          .eq("external_id", record.externalId)
          .eq("source", record.source)
          .maybeSingle();

        const { healthScore, churnRisk, stage } = calcHealth({
          nps: record.nps || 50, ces: record.ces || 3.5,
          productUsage: record.productUsage || 60,
          openTickets:  record.openTickets  || 0,
        });

        const row = {
          // user_id renamed to created_by in Phase 2 (Step 8); keep user_id until then
          user_id:      req.userId,
          org_id:       req.orgId,
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

        let accountId = null; let changed = null;

        if (existing) {
          if (existing.open_tickets !== record.openTickets
            || existing.last_contact !== record.lastContact) {
            await supabase.from("accounts").update(row)
              .eq("id", existing.id).eq("org_id", req.orgId);
            accountId = existing.id; changed = 'updated'; updated++;
          } else {
            changed = 'skipped'; skipped++;
          }
        } else {
          const { data: inserted } = await supabase.from("accounts").insert(row).select("id").single();
          accountId = inserted?.id; changed = 'created'; created++;
        }

        if (accountId && (changed === 'created' || changed === 'updated')) {
          try {
            const renewalNote = record.renewalDate ? `, renewal ${record.renewalDate}` : '';
            await writeInteraction({
              orgId:     req.orgId,
              accountId,
              source:    'crm_event',
              direction: 'internal',
              content:   `CRM ${changed === 'created' ? 'new account' : 'update'} (${record.source}): ${record.name} — ARR ${record.arr || 0}, ${record.openTickets || 0} open tickets${renewalNote}`,
              metadata: {
                connector_id:       connectorId,
                provider_source:    record.source,
                provider_object_id: record.externalId,
                arr:                record.arr || 0,
                open_tickets:       record.openTickets || 0,
                renewal_date:       record.renewalDate || null,
                last_contact:       record.lastContact || null,
                change:             changed,
              },
              externalId: `crm_${connectorId}_${record.externalId}_${new Date().toISOString().slice(0, 10)}`,
              createdBy:  req.userId,
            });
          } catch (e) {
            errors.push(`crm_event "${record.name}": ${e.message}`);
          }
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
    }).eq("org_id", req.orgId).eq("connector_id", connectorId);

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

// ── PATCH /api/sync/field-map ─────────────────────────────────────────────────
router.patch("/field-map", async (req, res, next) => {
  try {
    const { connectorId, fieldMap } = req.body;
    if (!connectorId) return res.status(400).json({ error: "connectorId is required" });

    const { error } = await supabase
      .from("integrations")
      .update({ field_map: fieldMap || {}, updated_at: new Date().toISOString() })
      .eq("org_id", req.orgId)
      .eq("connector_id", connectorId);

    if (error) throw error;
    res.json({ success: true });
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
