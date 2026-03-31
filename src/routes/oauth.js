/**
 * OAuth 2.0 flows for the four CRMs that support it:
 *   HubSpot · Salesforce · Zoho CRM · Microsoft Dynamics 365
 *
 * Flow for each:
 *   1. GET /oauth/:provider/connect  → redirect user to CRM login
 *   2. GET /oauth/:provider/callback → CRM redirects back here with ?code=
 *                                      We exchange code for tokens and save to DB
 *   3. GET /oauth/:provider/refresh  → refresh an expired access token
 */

const express  = require("express");
const axios    = require("axios");
const supabase = require("../supabase");

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const saveOAuthTokens = async (connectorId, accessToken, refreshToken, expiresIn) => {
  const expiry = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  await supabase.from("integrations").upsert({
    connector_id:  connectorId,
    connected:     true,
    oauth_token:   accessToken,
    oauth_refresh: refreshToken || null,
    oauth_expiry:  expiry,
    updated_at:    new Date().toISOString(),
  }, { onConflict: "connector_id" });
};

const frontendUrl = () => process.env.FRONTEND_URL || "http://localhost:5173";

// ─── HubSpot ──────────────────────────────────────────────────────────────────
router.get("/hubspot/connect", (req, res) => {
  const params = new URLSearchParams({
    client_id:    process.env.HUBSPOT_CLIENT_ID,
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
    scope:        "crm.objects.companies.read crm.objects.deals.read tickets",
  });
  res.redirect(`https://app.hubspot.com/oauth/authorize?${params}`);
});

router.get("/hubspot/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { data } = await axios.post("https://api.hubapi.com/oauth/v1/token", null, {
      params: {
        grant_type:    "authorization_code",
        client_id:     process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri:  process.env.HUBSPOT_REDIRECT_URI,
        code,
      },
    });
    await saveOAuthTokens("hubspot", data.access_token, data.refresh_token, data.expires_in);
    res.redirect(`${frontendUrl()}/integrations?connected=hubspot`);
  } catch (err) {
    console.error("[OAuth] HubSpot callback error:", err.message);
    res.redirect(`${frontendUrl()}/integrations?error=hubspot`);
  }
});

router.post("/hubspot/refresh", async (req, res, next) => {
  try {
    const { data: integration } = await supabase
      .from("integrations").select("oauth_refresh").eq("connector_id", "hubspot").single();

    const { data } = await axios.post("https://api.hubapi.com/oauth/v1/token", null, {
      params: {
        grant_type:    "refresh_token",
        client_id:     process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        refresh_token: integration.oauth_refresh,
      },
    });
    await saveOAuthTokens("hubspot", data.access_token, data.refresh_token, data.expires_in);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Salesforce ───────────────────────────────────────────────────────────────
router.get("/salesforce/connect", (req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     process.env.SALESFORCE_CLIENT_ID,
    redirect_uri:  process.env.SALESFORCE_REDIRECT_URI,
    scope:         "api refresh_token",
  });
  res.redirect(`https://login.salesforce.com/services/oauth2/authorize?${params}`);
});

router.get("/salesforce/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { data } = await axios.post("https://login.salesforce.com/services/oauth2/token", null, {
      params: {
        grant_type:    "authorization_code",
        client_id:     process.env.SALESFORCE_CLIENT_ID,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET,
        redirect_uri:  process.env.SALESFORCE_REDIRECT_URI,
        code,
      },
    });
    // Save instance_url alongside tokens so connectors know which SF org to hit
    await supabase.from("integrations").upsert({
      connector_id: "salesforce",
      connected:    true,
      oauth_token:  data.access_token,
      oauth_refresh:data.refresh_token,
      credentials:  { instanceUrl: data.instance_url },
      updated_at:   new Date().toISOString(),
    }, { onConflict: "connector_id" });

    res.redirect(`${frontendUrl()}/integrations?connected=salesforce`);
  } catch (err) {
    console.error("[OAuth] Salesforce callback error:", err.message);
    res.redirect(`${frontendUrl()}/integrations?error=salesforce`);
  }
});

router.post("/salesforce/refresh", async (req, res, next) => {
  try {
    const { data: integration } = await supabase
      .from("integrations").select("oauth_refresh,credentials").eq("connector_id", "salesforce").single();

    const { data } = await axios.post("https://login.salesforce.com/services/oauth2/token", null, {
      params: {
        grant_type:    "refresh_token",
        client_id:     process.env.SALESFORCE_CLIENT_ID,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET,
        refresh_token: integration.oauth_refresh,
      },
    });
    await saveOAuthTokens("salesforce", data.access_token, integration.oauth_refresh, 7200);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Zoho CRM ─────────────────────────────────────────────────────────────────
router.get("/zoho/connect", (req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     process.env.ZOHO_CLIENT_ID,
    redirect_uri:  process.env.ZOHO_REDIRECT_URI,
    scope:         "ZohoCRM.modules.Accounts.READ,ZohoDesk.tickets.READ",
    access_type:   "offline",
  });
  res.redirect(`https://accounts.zoho.com/oauth/v2/auth?${params}`);
});

router.get("/zoho/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { data } = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
      params: {
        grant_type:    "authorization_code",
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri:  process.env.ZOHO_REDIRECT_URI,
        code,
      },
    });
    await saveOAuthTokens("zoho", data.access_token, data.refresh_token, data.expires_in);
    res.redirect(`${frontendUrl()}/integrations?connected=zoho`);
  } catch (err) {
    console.error("[OAuth] Zoho callback error:", err.message);
    res.redirect(`${frontendUrl()}/integrations?error=zoho`);
  }
});

router.post("/zoho/refresh", async (req, res, next) => {
  try {
    const { data: integration } = await supabase
      .from("integrations").select("oauth_refresh").eq("connector_id", "zoho").single();

    const { data } = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
      params: {
        grant_type:    "refresh_token",
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        refresh_token: integration.oauth_refresh,
      },
    });
    await saveOAuthTokens("zoho", data.access_token, integration.oauth_refresh, data.expires_in);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Microsoft Dynamics 365 ───────────────────────────────────────────────────
router.get("/dynamics/connect", (req, res) => {
  const tenant = process.env.DYNAMICS_TENANT_ID || "common";
  const params = new URLSearchParams({
    client_id:     process.env.DYNAMICS_CLIENT_ID,
    response_type: "code",
    redirect_uri:  process.env.DYNAMICS_REDIRECT_URI,
    scope:         "https://dynamics.microsoft.com/.default offline_access",
    response_mode: "query",
  });
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`);
});

router.get("/dynamics/callback", async (req, res) => {
  const { code } = req.query;
  const tenant   = process.env.DYNAMICS_TENANT_ID || "common";
  try {
    const { data } = await axios.post(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id:     process.env.DYNAMICS_CLIENT_ID,
        client_secret: process.env.DYNAMICS_CLIENT_SECRET,
        grant_type:    "authorization_code",
        redirect_uri:  process.env.DYNAMICS_REDIRECT_URI,
        code,
        scope:         "https://dynamics.microsoft.com/.default offline_access",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    await saveOAuthTokens("dynamics365", data.access_token, data.refresh_token, data.expires_in);
    res.redirect(`${frontendUrl()}/integrations?connected=dynamics365`);
  } catch (err) {
    console.error("[OAuth] Dynamics callback error:", err.message);
    res.redirect(`${frontendUrl()}/integrations?error=dynamics365`);
  }
});

router.post("/dynamics/refresh", async (req, res, next) => {
  try {
    const tenant = process.env.DYNAMICS_TENANT_ID || "common";
    const { data: integration } = await supabase
      .from("integrations").select("oauth_refresh").eq("connector_id", "dynamics365").single();

    const { data } = await axios.post(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id:     process.env.DYNAMICS_CLIENT_ID,
        client_secret: process.env.DYNAMICS_CLIENT_SECRET,
        grant_type:    "refresh_token",
        refresh_token: integration.oauth_refresh,
        scope:         "https://dynamics.microsoft.com/.default offline_access",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    await saveOAuthTokens("dynamics365", data.access_token, data.refresh_token, data.expires_in);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
