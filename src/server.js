require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const cron      = require("node-cron");

// ── Startup environment validation ────────────────────────────────────────────
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_ANON_KEY",
  "PULSE_API_SECRET",
  "ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "FRONTEND_URL",
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n[FATAL] Missing required environment variables:\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}
if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error("\n[FATAL] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).\n  Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n");
  process.exit(1);
}

const accountsRouter           = require("./routes/accounts");
const syncRouter               = require("./routes/sync");
const oauthRouter              = require("./routes/oauth");
const authRouter               = require("./routes/auth");
const surveysRouter            = require("./routes/surveys");
const surveyRespondRouter      = require("./routes/survey-respond");
const emailAuthRouter          = require("./routes/emailAuth");
const whatsappRouter           = require("./routes/whatsapp");
const automationRouter         = require("./routes/automation");
const onboardingRouter         = require("./routes/onboarding");
const portalRouter             = require("./routes/portal");
const handoverRouter           = require("./routes/handover");
const portalManageRouter       = require("./routes/portalManage");
const tasksRouter              = require("./routes/tasks");
const briefingRouter           = require("./routes/briefing");
const aiRouter                 = require("./routes/ai");
const meetingsRouter           = require("./routes/meetings");
const { publicRouter: webhookPublicRouter, apiRouter: webhookApiRouter } = require("./routes/webhook");
const auditLogRouter               = require("./routes/auditLog");
const { runAutomationEngine }  = require("./engine/automationRunner");
const { runBriefingEngine }    = require("./engine/briefingRunner");
const { runGmailSync }         = require("./engine/gmailIngestion");
const { runFirefliesSync }     = require("./engine/firefliesIngestion");
const { requireApiKey, requireUser } = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy — required for rate limiting to work correctly
app.set("trust proxy", 1);

// ── Security headers (helmet) ─────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // allow frontend fetches
  contentSecurityPolicy: false, // API server — no HTML served
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5174",
    /\.vercel\.app$/,   // allow all Vercel preview URLs
  ],
  credentials: true,
}));

app.use(express.json({ limit: "2mb" }));

// Global rate limit
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
}));

// Per-user AI rate limit — applied to /api/ai/* when those routes are mounted
const aiRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour window
  max: 30,                     // 30 AI calls per user per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.userId || req.ip,
  message: { error: "AI rate limit exceeded — max 30 calls per hour per user." },
});
// Exported so ai.js router can use it: app.use("/api/ai", aiRateLimit, aiRouter)
app.set("aiRateLimit", aiRateLimit);

// ── Health check (public) ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// ── Public routes ─────────────────────────────────────────────────────────────
app.use("/auth",    authRouter);
app.use("/oauth",   oauthRouter);
app.use("/survey",  surveyRespondRouter);   // customers submit here — no auth
app.use("/api/email",     emailAuthRouter);  // email OAuth callbacks must be public
app.use("/api/whatsapp", whatsappRouter);   // webhook must be public — Meta sends here
app.use("/portal",       portalRouter);       // customer portal — public magic link
app.use("/handover",     handoverRouter);     // sales handover — public magic link
app.use("/webhook",      webhookPublicRouter); // product usage webhook — public

// ── Protected API routes ──────────────────────────────────────────────────────
app.use("/api", requireApiKey, requireUser);
app.use("/api/accounts",   accountsRouter);
app.use("/api/sync",       syncRouter);
app.use("/api/surveys",    surveysRouter);
app.use("/api/automation",  automationRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/portal",     portalManageRouter);
app.use("/api/tasks",      tasksRouter);
app.use("/api/briefing",   briefingRouter);
app.use("/api/ai",         app.get("aiRateLimit"), aiRouter);
app.use("/api/meetings",   meetingsRouter);
app.use("/api/webhook",    webhookApiRouter);
app.use("/api/audit",     auditLogRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n✓ Pulse backend running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Mode:   ${process.env.NODE_ENV || "development"}\n`);

  // Run automation engine every hour
  cron.schedule("0 * * * *", runAutomationEngine);
  console.log("  Automation engine scheduled (hourly)");

  // Run briefing engine every hour (generates + sends for users whose time is now)
  cron.schedule("0 * * * *", runBriefingEngine);
  console.log("  Briefing engine scheduled (hourly)");

  // Sync Gmail threads every 6 hours
  cron.schedule("0 */6 * * *", runGmailSync);
  console.log("  Gmail sync scheduled (every 6 hours)");

  // Sync Fireflies meeting notes every 6 hours
  cron.schedule("0 */6 * * *", runFirefliesSync);
  console.log("  Fireflies sync scheduled (every 6 hours)\n");
});

module.exports = app;
