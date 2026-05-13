require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");

const cron = require("node-cron");

const accountsRouter           = require("./routes/accounts");
const syncRouter               = require("./routes/sync");
const oauthRouter              = require("./routes/oauth");
const authRouter               = require("./routes/auth");
const surveysRouter            = require("./routes/surveys");
const surveyRespondRouter      = require("./routes/survey-respond");
const emailAuthRouter          = require("./routes/emailAuth");
const whatsappRouter           = require("./routes/whatsapp");
const automationRouter         = require("./routes/automation");
const { runAutomationEngine }  = require("./engine/automationRunner");
const { requireApiKey, requireUser } = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy — required for rate limiting to work correctly
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5174",
    /\.vercel\.app$/,   // allow all Vercel preview URLs
  ],
  credentials: true,
}));

app.use(express.json({ limit: "2mb" }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "Too many requests — please slow down." },
}));

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

// ── Protected API routes ──────────────────────────────────────────────────────
app.use("/api", requireApiKey, requireUser);
app.use("/api/accounts",   accountsRouter);
app.use("/api/sync",       syncRouter);
app.use("/api/surveys",    surveysRouter);
app.use("/api/automation", automationRouter);

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
  console.log("  Automation engine scheduled (hourly)\n");
});

module.exports = app;
