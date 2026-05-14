/**
 * CRM & Ticketing Connectors
 *
 * Each connector exports a single async function:
 *   fetchAccounts(credentials, fieldMap) → Array<PulseAccount>
 *
 * The fieldMap tells the connector which CRM field maps to which Pulse field.
 * Every connector normalises its data into the same Pulse account shape before returning.
 */

const axios = require("axios");

// ─── Normalisation helpers ────────────────────────────────────────────────────
const toDate = (val) => {
  if (!val) return null;
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  } catch { return null; }
};

const toNum = (val, fallback = 0) => {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
};

const applyFieldMap = (record, fieldMap) => {
  const result = {};
  Object.entries(fieldMap).forEach(([crmKey, pulseField]) => {
    if (pulseField && pulseField !== "__skip" && record[crmKey] !== undefined) {
      result[pulseField] = record[crmKey];
    }
  });
  return result;
};

// ─── HubSpot ──────────────────────────────────────────────────────────────────
const fetchHubSpot = async ({ apiKey, portalId }, fieldMap) => {
  const properties = Object.keys(fieldMap).join(",");
  const res = await axios.get(
    `https://api.hubapi.com/crm/v3/objects/companies?properties=${properties}&limit=100`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  return (res.data.results || []).map(r => {
    const mapped = applyFieldMap(r.properties || {}, fieldMap);
    return {
      externalId: r.id,
      source:     "hubspot",
      name:       mapped.name || r.properties?.name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr),
      renewalDate:toDate(mapped.renewalDate),
      openTickets:toNum(mapped.openTickets),
      lastContact:toDate(mapped.lastContact) || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Salesforce ───────────────────────────────────────────────────────────────
const fetchSalesforce = async ({ instanceUrl, accessToken }, fieldMap) => {
  const fields  = [...new Set(["Id", "Name", ...Object.keys(fieldMap)])].join(",");
  const soql    = encodeURIComponent(`SELECT ${fields} FROM Account LIMIT 200`);
  const res     = await axios.get(`${instanceUrl}/services/data/v57.0/query?q=${soql}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (res.data.records || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId: r.Id,
      source:     "salesforce",
      name:       mapped.name || r.Name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr),
      renewalDate:toDate(mapped.renewalDate),
      openTickets:toNum(mapped.openTickets),
      lastContact:toDate(mapped.lastContact) || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Zoho CRM + Zoho Desk ────────────────────────────────────────────────────
const fetchZoho = async ({ clientId, clientSecret, refreshToken, dc = "com", deskOrgId }, fieldMap) => {
  // Step 1: get a fresh access token using the refresh token
  const tokenRes = await axios.post(
    `https://accounts.zoho.${dc}/oauth/v2/token`,
    null,
    { params: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" } }
  );
  if (!tokenRes.data.access_token) throw new Error("Zoho token refresh failed — check credentials");
  const accessToken = tokenRes.data.access_token;
  const authHeader  = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const crmBase     = `https://www.zohoapis.${dc}/crm/v6`;

  // Step 2: fetch CRM accounts
  const crmFields = ["Account_Name","Industry","Annual_Revenue","Contract_Renewal_Date","Last_Activity_Time","Website"].join(",");
  const accountsRes = await axios.get(`${crmBase}/Accounts?fields=${crmFields}&per_page=200`, { headers: authHeader });

  // Step 3: fetch CRM contacts (for stakeholders)
  const contactsRes = await axios.get(
    `${crmBase}/Contacts?fields=First_Name,Last_Name,Email,Title,Account_Name&per_page=200`,
    { headers: authHeader }
  ).catch(() => ({ data: { data: [] } }));

  // Build contacts-by-account-name lookup
  const contactsByAccount = {};
  for (const c of ((contactsRes.data || {}).data || [])) {
    const acctName = c.Account_Name?.name || c.Account_Name || null;
    if (!acctName) continue;
    if (!contactsByAccount[acctName]) contactsByAccount[acctName] = [];
    contactsByAccount[acctName].push({
      name:  `${c.First_Name || ""} ${c.Last_Name || ""}`.trim(),
      email: c.Email || null,
      title: c.Title || "",
    });
  }

  // Step 4: fetch Zoho Desk open tickets (optional — only if deskOrgId provided)
  const deskTickets = {};
  if (deskOrgId) {
    const deskRes = await axios.get(
      `https://desk.zoho.${dc}/api/v1/tickets?status=open&limit=100`,
      { headers: { ...authHeader, orgId: deskOrgId } }
    ).catch(() => ({ data: { data: [] } }));
    for (const t of ((deskRes.data || {}).data || [])) {
      const name = t.account?.accountName;
      if (name) deskTickets[name] = (deskTickets[name] || 0) + 1;
    }
  }

  return ((accountsRes.data || {}).data || []).map(r => {
    const name = r.Account_Name || "Unknown";
    return {
      externalId:  r.id,
      source:      "zoho",
      name,
      industry:    r.Industry   || "",
      arr:         toNum(r.Annual_Revenue),
      renewalDate: toDate(r.Contract_Renewal_Date),
      openTickets: deskTickets[name] || 0,
      lastContact: toDate(r.Last_Activity_Time) || new Date().toISOString().split("T")[0],
      contacts:    contactsByAccount[name] || [],
    };
  });
};

// ─── Odoo ─────────────────────────────────────────────────────────────────────
const fetchOdoo = async ({ instanceUrl, database, apiKey }, fieldMap) => {
  const fields = Object.keys(fieldMap);
  const res    = await axios.post(`${instanceUrl}/web/dataset/call_kw`, {
    jsonrpc: "2.0", method: "call", id: 1,
    params: {
      model:  "crm.lead",
      method: "search_read",
      args:   [[["type", "=", "opportunity"], ["probability", ">", 0]]],
      kwargs: {
        fields: ["id", "name", ...fields],
        limit:  200,
        context: { lang: "en_US" },
      },
    },
  }, { headers: { "X-Odoo-Api-Key": apiKey } });

  return ((res.data.result) || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId: String(r.id),
      source:     "odoo",
      name:       mapped.name || r.name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr),
      renewalDate:toDate(mapped.renewalDate),
      openTickets:toNum(mapped.openTickets),
      lastContact:toDate(mapped.lastContact) || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── FreshSales ───────────────────────────────────────────────────────────────
const fetchFreshSales = async ({ domain, apiKey }, fieldMap) => {
  const res = await axios.get(
    `https://${domain}.freshsales.io/api/deals?include=account`,
    {
      headers: {
        Authorization: `Token token=${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  return ((res.data || {}).deals || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId: String(r.id),
      source:     "freshsales",
      name:       mapped.name || r.name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr || r.deal_value),
      renewalDate:toDate(mapped.renewalDate || r.renewal_date),
      openTickets:toNum(mapped.openTickets),
      lastContact:toDate(mapped.lastContact || r.last_contacted) || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Intercom ─────────────────────────────────────────────────────────────────
const fetchIntercom = async ({ accessToken }, fieldMap) => {
  const res = await axios.get("https://api.intercom.io/companies?per_page=60", {
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Intercom-Version": "2.9",
    },
  });
  return ((res.data || {}).data || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId: r.id,
      source:     "intercom",
      name:       mapped.name || r.name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr || r.monthly_spend) * 12,
      renewalDate:toDate(mapped.renewalDate),
      openTickets:toNum(mapped.openTickets || r.open_conversations),
      lastContact:toDate(mapped.lastContact || (r.last_seen_at ? new Date(r.last_seen_at * 1000) : null))
                  || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Pipedrive ────────────────────────────────────────────────────────────────
const fetchPipedrive = async ({ apiToken, companyDomain }, fieldMap) => {
  const base = `https://${companyDomain}.pipedrive.com/v1`;
  const res  = await axios.get(`${base}/deals?status=open&limit=200&api_token=${apiToken}`);
  return ((res.data || {}).data || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId:  String(r.id),
      source:      "pipedrive",
      name:        r.org_name || mapped.name || "Unknown",
      industry:    mapped.industry || "",
      arr:         toNum(mapped.arr || r.value),
      renewalDate: toDate(mapped.renewalDate || r.close_time || r.expected_close_date),
      openTickets: toNum(mapped.openTickets || r.activities_count),
      lastContact: toDate(mapped.lastContact || r.last_activity_date)
                   || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Microsoft Dynamics 365 ───────────────────────────────────────────────────
const fetchDynamics = async ({ accessToken, instanceUrl }, fieldMap) => {
  const select = [...new Set(["accountid", "name", ...Object.keys(fieldMap)])].join(",");
  const res    = await axios.get(
    `${instanceUrl}/api/data/v9.2/accounts?$select=${select}&$top=200`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "OData-MaxVersion": "4.0",
        "OData-Version":    "4.0",
        Accept:             "application/json",
      },
    }
  );
  return ((res.data || {}).value || []).map(r => {
    const mapped = applyFieldMap(r, fieldMap);
    return {
      externalId: r.accountid,
      source:     "dynamics365",
      name:       mapped.name || r.name || "Unknown",
      industry:   mapped.industry || "",
      arr:        toNum(mapped.arr || r.estimatedvalue),
      renewalDate:toDate(mapped.renewalDate || r.estimatedclosedate),
      openTickets:toNum(mapped.openTickets),
      lastContact:toDate(mapped.lastContact) || new Date().toISOString().split("T")[0],
    };
  });
};

// ─── Zendesk ──────────────────────────────────────────────────────────────────
const fetchZendesk = async ({ subdomain, email, apiToken }, fieldMap) => {
  const auth  = Buffer.from(`${email}/token:${apiToken}`).toString("base64");
  const orgs  = await axios.get(
    `https://${subdomain}.zendesk.com/api/v2/organizations.json?per_page=100`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return await Promise.all(
    ((orgs.data || {}).organizations || []).map(async org => {
      // Get open ticket count for this organisation
      let openCount = 0;
      try {
        const tickets = await axios.get(
          `https://${subdomain}.zendesk.com/api/v2/organizations/${org.id}/tickets.json?status=open`,
          { headers: { Authorization: `Basic ${auth}` } }
        );
        openCount = tickets.data.count || 0;
      } catch {}

      return {
        externalId:  String(org.id),
        source:      "zendesk",
        name:        org.name || "Unknown",
        industry:    "",
        arr:         0,
        renewalDate: null,
        openTickets: openCount,
        lastContact: toDate(org.updated_at) || new Date().toISOString().split("T")[0],
        notes:       org.notes || "",
      };
    })
  );
};

// ─── Jira Service Management ─────────────────────────────────────────────────
const fetchJira = async ({ domain, email, apiToken }, fieldMap) => {
  const auth    = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };

  // Fetch all service desk projects
  const projects = await axios.get(
    `https://${domain}/rest/servicedeskapi/servicedesk`,
    { headers }
  );

  return await Promise.all(
    ((projects.data || {}).values || []).map(async project => {
      let openCount = 0;
      try {
        const issues = await axios.get(
          `https://${domain}/rest/api/3/search?jql=project=${project.projectKey}+AND+status!=Done&maxResults=0`,
          { headers }
        );
        openCount = issues.data.total || 0;
      } catch {}

      return {
        externalId:  String(project.id),
        source:      "jira",
        name:        project.projectName || "Unknown",
        industry:    "",
        arr:         0,
        renewalDate: null,
        openTickets: openCount,
        lastContact: new Date().toISOString().split("T")[0],
      };
    })
  );
};

// ─── ServiceNow ───────────────────────────────────────────────────────────────
const fetchServiceNow = async ({ instanceUrl, username, password }, fieldMap) => {
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const res  = await axios.get(
    `${instanceUrl}/api/now/table/core_company?sysparm_limit=200&sysparm_fields=sys_id,name,notes,sys_updated_on`,
    {
      headers: {
        Authorization:  `Basic ${auth}`,
        Accept:         "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  return await Promise.all(
    ((res.data || {}).result || []).map(async company => {
      let openIncidents = 0;
      try {
        const inc = await axios.get(
          `${instanceUrl}/api/now/table/incident?company=${company.sys_id}&active=true&sysparm_limit=0&sysparm_count=true`,
          { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } }
        );
        openIncidents = parseInt(inc.headers["x-total-count"] || "0");
      } catch {}

      return {
        externalId:  company.sys_id,
        source:      "servicenow",
        name:        company.name || "Unknown",
        industry:    "",
        arr:         0,
        renewalDate: null,
        openTickets: openIncidents,
        lastContact: toDate(company.sys_updated_on) || new Date().toISOString().split("T")[0],
        notes:       company.notes || "",
      };
    })
  );
};

// ─── HubSpot Service Hub ──────────────────────────────────────────────────────
const fetchHubSpotService = async ({ apiKey, portalId }, fieldMap) => {
  // Group open tickets by company association
  const res = await axios.get(
    "https://api.hubapi.com/crm/v3/objects/tickets?properties=hs_pipeline_stage,subject,hs_ticket_priority&associations=company&limit=100&filters=hs_pipeline_stage:neq:4",
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  // Aggregate by company
  const byCompany = {};
  ((res.data || {}).results || []).forEach(ticket => {
    const companyId = ticket.associations?.companies?.results?.[0]?.id || "unknown";
    if (!byCompany[companyId]) byCompany[companyId] = { count: 0, lastUpdated: null };
    byCompany[companyId].count++;
    byCompany[companyId].lastUpdated = ticket.updatedAt;
  });

  // Fetch company names for matched IDs
  const companyIds = Object.keys(byCompany).filter(id => id !== "unknown");
  const companies  = [];

  for (const id of companyIds.slice(0, 50)) {
    try {
      const c = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/companies/${id}?properties=name`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      companies.push({
        externalId:  id,
        source:      "hubspot_service",
        name:        c.data.properties?.name || "Unknown",
        industry:    "",
        arr:         0,
        renewalDate: null,
        openTickets: byCompany[id].count,
        lastContact: toDate(byCompany[id].lastUpdated) || new Date().toISOString().split("T")[0],
      });
    } catch {}
  }

  return companies;
};

// ─── Help Scout ───────────────────────────────────────────────────────────────
const fetchHelpScout = async ({ appId, appSecret }, fieldMap) => {
  // Get OAuth token
  const tokenRes = await axios.post("https://api.helpscout.net/v2/tokens", {
    grant_type:    "client_credentials",
    client_id:     appId,
    client_secret: appSecret,
  });
  const token = tokenRes.data.access_token;
  const headers = { Authorization: `Bearer ${token}` };

  // Fetch customers grouped by company
  const convRes = await axios.get(
    "https://api.helpscout.net/v2/conversations?status=active&page=1&pageSize=100",
    { headers }
  );

  const byCompany = {};
  ((convRes.data?._embedded || {}).conversations || []).forEach(conv => {
    const company = conv.customer?.company || "Unknown";
    if (!byCompany[company]) byCompany[company] = { count: 0, lastUpdated: null };
    byCompany[company].count++;
    if (!byCompany[company].lastUpdated || conv.userUpdatedAt > byCompany[company].lastUpdated) {
      byCompany[company].lastUpdated = conv.userUpdatedAt;
    }
  });

  return Object.entries(byCompany).map(([name, data]) => ({
    externalId:  `helpscout-${name.toLowerCase().replace(/\s+/g, "-")}`,
    source:      "helpscout",
    name,
    industry:    "",
    arr:         0,
    renewalDate: null,
    openTickets: data.count,
    lastContact: toDate(data.lastUpdated) || new Date().toISOString().split("T")[0],
  }));
};

// ─── Kayako ───────────────────────────────────────────────────────────────────
const fetchKayako = async ({ subdomain, email, password }, fieldMap) => {
  const auth    = Buffer.from(`${email}:${password}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };

  const orgsRes = await axios.get(
    `https://${subdomain}.kayako.com/api/v1/organizations?limit=100`,
    { headers }
  );

  return await Promise.all(
    ((orgsRes.data || {}).data || []).map(async org => {
      let openCases = 0;
      try {
        const cases = await axios.get(
          `https://${subdomain}.kayako.com/api/v1/cases?organization_id=${org.id}&status=open`,
          { headers }
        );
        openCases = (cases.data?.data || []).length;
      } catch {}

      return {
        externalId:  String(org.id),
        source:      "kayako",
        name:        org.name || "Unknown",
        industry:    "",
        arr:         0,
        renewalDate: null,
        openTickets: openCases,
        lastContact: toDate(org.last_updated) || new Date().toISOString().split("T")[0],
      };
    })
  );
};

// ─── Front ────────────────────────────────────────────────────────────────────
const fetchFront = async ({ apiToken }, fieldMap) => {
  const headers = { Authorization: `Bearer ${apiToken}` };

  const contactsRes = await axios.get(
    "https://api2.frontapp.com/contacts?limit=100",
    { headers }
  );

  const byCompany = {};
  ((contactsRes.data?._results) || []).forEach(contact => {
    const company = contact.name || "Unknown";
    if (!byCompany[company]) byCompany[company] = { count: 0, lastMessage: null, id: contact.id };
    byCompany[company].lastMessage = contact.last_seen;
  });

  // Fetch open conversation counts per company
  const convsRes = await axios.get(
    "https://api2.frontapp.com/conversations?q[statuses][]=open&limit=100",
    { headers }
  );

  ((convsRes.data?._results) || []).forEach(conv => {
    const company = conv.recipient?.name || "Unknown";
    if (!byCompany[company]) byCompany[company] = { count: 0, lastMessage: null };
    byCompany[company].count++;
    if (!byCompany[company].lastMessage || conv.last_message?.created_at > byCompany[company].lastMessage) {
      byCompany[company].lastMessage = conv.last_message?.created_at;
    }
  });

  return Object.entries(byCompany).map(([name, data]) => ({
    externalId:  `front-${name.toLowerCase().replace(/\s+/g, "-")}`,
    source:      "front",
    name,
    industry:    "",
    arr:         0,
    renewalDate: null,
    openTickets: data.count,
    lastContact: toDate(data.lastMessage) || new Date().toISOString().split("T")[0],
  }));
};

// ─── Zoho Desk (standalone) ───────────────────────────────────────────────────
const fetchZohoDesk = async ({ clientId, clientSecret, refreshToken, dc = "com", orgId }, fieldMap) => {
  const tokenRes = await axios.post(
    `https://accounts.zoho.${dc}/oauth/v2/token`,
    null,
    { params: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" } }
  );
  if (!tokenRes.data.access_token) throw new Error("Zoho token refresh failed — check credentials");
  const headers = { Authorization: `Zoho-oauthtoken ${tokenRes.data.access_token}`, orgId };
  const base    = `https://desk.zoho.${dc}/api/v1`;

  const accountsRes = await axios.get(`${base}/accounts?limit=100`, { headers });
  const accounts    = accountsRes.data?.data || [];

  const ticketsRes = await axios.get(`${base}/tickets?status=open&limit=100`, { headers })
    .catch(() => ({ data: { data: [] } }));
  const ticketsByAccount = {};
  for (const t of (ticketsRes.data?.data || [])) {
    if (t.accountId) ticketsByAccount[t.accountId] = (ticketsByAccount[t.accountId] || 0) + 1;
  }

  return accounts.map(acct => ({
    externalId:  acct.id,
    source:      "zoho_desk",
    name:        acct.accountName || "Unknown",
    industry:    acct.industry || "",
    arr:         0,
    renewalDate: null,
    openTickets: ticketsByAccount[acct.id] || 0,
    lastContact: toDate(acct.modifiedTime) || new Date().toISOString().split("T")[0],
  }));
};

// ─── Fireflies.ai (connection test only — sync handled by firefliesIngestion) ──
const fetchFireflies = async ({ apiKey }, fieldMap) => {
  const res = await axios.post(
    "https://api.fireflies.ai/graphql",
    { query: "{ user { user_id name email } }" },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );
  if (res.data?.errors?.length) {
    throw new Error(res.data.errors[0]?.message || "Invalid API key");
  }
  return []; // actual sync is handled by the Fireflies ingestion engine
};

// ─── Freshdesk ────────────────────────────────────────────────────────────────
const fetchFreshdesk = async ({ domain, apiKey }, fieldMap) => {
  const auth    = Buffer.from(`${apiKey}:X`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };
  const base    = `https://${domain}.freshdesk.com/api/v2`;

  // Fetch all companies
  const companiesRes = await axios.get(`${base}/companies?page=1&per_page=100`, { headers });
  const companies    = companiesRes.data || [];

  return await Promise.all(companies.map(async company => {
    let openTickets = 0;
    try {
      // status=2 → Open in Freshdesk
      const tRes = await axios.get(
        `${base}/tickets?company_id=${company.id}&status=2&per_page=100`,
        { headers }
      );
      openTickets = Array.isArray(tRes.data) ? tRes.data.length : 0;
    } catch {}

    return {
      externalId:  String(company.id),
      source:      "freshdesk",
      name:        company.name || "Unknown",
      industry:    "",
      arr:         0,
      renewalDate: null,
      openTickets,
      lastContact: toDate(company.updated_at) || new Date().toISOString().split("T")[0],
      notes:       company.description || "",
    };
  }));
};

// ─── Connector registry ───────────────────────────────────────────────────────
const CONNECTORS = {
  hubspot:         fetchHubSpot,
  salesforce:      fetchSalesforce,
  zoho:            fetchZoho,
  zoho_desk:       fetchZohoDesk,
  odoo:            fetchOdoo,
  freshsales:      fetchFreshSales,
  freshdesk:       fetchFreshdesk,
  intercom:        fetchIntercom,
  pipedrive:       fetchPipedrive,
  dynamics365:     fetchDynamics,
  zendesk:         fetchZendesk,
  servicenow:      fetchServiceNow,
  hubspot_service: fetchHubSpotService,
  helpscout:       fetchHelpScout,
  kayako:          fetchKayako,
  front:           fetchFront,
  fireflies:       fetchFireflies,
};

module.exports = { CONNECTORS };
