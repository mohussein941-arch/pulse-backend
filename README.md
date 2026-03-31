# Pulse Backend — Deployment Guide

Stack: Node.js + Express · Supabase (Postgres) · Railway

---

## Step 1 — Set up Supabase

1. Go to https://supabase.com and create a free account
2. Click **New project** — give it a name like `pulse-backend`
3. Set a strong database password and save it somewhere safe
4. Wait ~2 minutes for the project to provision

### Run the schema

5. In your Supabase project, click **SQL Editor** in the left sidebar
6. Click **New query**
7. Copy the entire contents of `supabase/schema.sql` in this repo
8. Paste it into the editor and click **Run**
9. You should see "Success. No rows returned" — that means all tables were created

### Get your Supabase credentials

10. Go to **Settings → API** in your Supabase project
11. Copy:
    - **Project URL** → this is your `SUPABASE_URL`
    - **service_role** key (not the anon key) → this is your `SUPABASE_SERVICE_KEY`

---

## Step 2 — Run locally first

```bash
# Clone or navigate to the pulse-backend folder
cd pulse-backend

# Install dependencies
npm install

# Copy the environment template
cp .env.example .env

# Open .env and fill in your Supabase credentials:
# SUPABASE_URL=https://xxxx.supabase.co
# SUPABASE_SERVICE_KEY=eyJhbGci...

# Generate a random API secret (run this in your terminal):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output into PULSE_API_SECRET in your .env

# Start the server
npm run dev
```

You should see:
```
✓ Pulse backend running on port 3001
  Health check: http://localhost:3001/health
```

Test it: open http://localhost:3001/health in your browser. You should get:
```json
{ "status": "ok", "version": "1.0.0" }
```

---

## Step 3 — Deploy to Railway

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Connect your GitHub account and select the `pulse-backend` repository
   (push the code to GitHub first if you haven't already)
4. Railway will detect the `railway.json` and start building automatically

### Add environment variables in Railway

5. In your Railway project, click your service → **Variables** tab
6. Add each variable from your `.env` file:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `PULSE_API_SECRET` (same one you generated above)
   - `FRONTEND_URL` → your Vercel frontend URL (e.g. https://pulse.vercel.app)
   - `NODE_ENV` → `production`

7. Railway will redeploy automatically after you add variables

8. Once deployed, copy your Railway URL (e.g. https://pulse-backend-production.up.railway.app)

---

## Step 4 — Connect the frontend to the backend

In your Pulse frontend (the React app), add a `.env` file:

```
VITE_API_URL=https://pulse-backend-production.up.railway.app
VITE_API_SECRET=your-same-pulse-api-secret
```

Then update the frontend to call the API instead of localStorage.
(This is the next phase — wiring the frontend API client.)

---

## Step 5 — Set up OAuth apps (optional — for OAuth connectors)

Only needed if you want one-click OAuth connect instead of API key paste.

### HubSpot
1. Go to https://developers.hubspot.com → Create app
2. Set redirect URI to: `https://your-railway-url.up.railway.app/oauth/hubspot/callback`
3. Copy Client ID and Client Secret into Railway environment variables

### Salesforce
1. Go to Setup → App Manager → New Connected App
2. Enable OAuth, set callback URL to: `https://your-railway-url.up.railway.app/oauth/salesforce/callback`
3. Add scopes: api, refresh_token

### Zoho CRM
1. Go to https://api-console.zoho.com → Add Client → Server-based Application
2. Set authorized redirect URI to: `https://your-railway-url.up.railway.app/oauth/zoho/callback`

### Microsoft Dynamics 365
1. Go to Azure Portal → App registrations → New registration
2. Set redirect URI to: `https://your-railway-url.up.railway.app/oauth/dynamics/callback`
3. Add API permission: Dynamics CRM → user_impersonation
4. Create a client secret under Certificates & Secrets

---

## API Reference

All endpoints require the header: `x-pulse-secret: <your PULSE_API_SECRET>`
except `/health` and `/oauth/*` which are public.

### Accounts
| Method | Path | Description |
|--------|------|-------------|
| GET    | /api/accounts | Fetch all accounts with full related data |
| POST   | /api/accounts | Create a single account |
| PATCH  | /api/accounts/:id | Update account, health signals, activities, milestones |
| DELETE | /api/accounts/:id | Delete account and all related data |
| POST   | /api/accounts/bulk | Bulk import array of accounts |

### Sync
| Method | Path | Description |
|--------|------|-------------|
| GET    | /api/sync/status | Get all integration configs |
| POST   | /api/sync/configure | Save credentials + field map for a connector |
| POST   | /api/sync/test | Test connection without saving |
| POST   | /api/sync/run | Run a full sync for a connector |
| GET    | /api/sync/log/:connectorId | Get last 10 sync results |

### OAuth
| Method | Path | Description |
|--------|------|-------------|
| GET    | /oauth/hubspot/connect | Start HubSpot OAuth flow |
| GET    | /oauth/hubspot/callback | HubSpot OAuth callback |
| POST   | /oauth/hubspot/refresh | Refresh HubSpot token |
| GET    | /oauth/salesforce/connect | Start Salesforce OAuth flow |
| GET    | /oauth/salesforce/callback | Salesforce callback |
| POST   | /oauth/salesforce/refresh | Refresh Salesforce token |
| GET    | /oauth/zoho/connect | Start Zoho OAuth flow |
| GET    | /oauth/zoho/callback | Zoho callback |
| POST   | /oauth/zoho/refresh | Refresh Zoho token |
| GET    | /oauth/dynamics/connect | Start Dynamics OAuth flow |
| GET    | /oauth/dynamics/callback | Dynamics callback |
| POST   | /oauth/dynamics/refresh | Refresh Dynamics token |

---

## Health check

GET /health → `{ "status": "ok", "version": "1.0.0", "timestamp": "..." }`

Railway uses this endpoint to confirm the service is running. If it returns anything other than 200, Railway will restart the container.
