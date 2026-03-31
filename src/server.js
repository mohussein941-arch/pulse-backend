require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");

const accountsRouter           = require("./routes/accounts");
const syncRouter               = require("./routes/sync");
const oauthRouter              = require("./routes/oauth");
const authRouter               = require("./routes/auth");
const { requireApiKey, requireUser } = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "Too many requests — please slow down." },
}));

// ── Health check (public) ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// ── Auth routes (public — login, signup, profile) ─────────────────────────────
app.use("/auth", authRouter);

// ── OAuth callback routes (public — CRM redirects back here) ─────────────────
app.use("/oauth", oauthRouter);

// ── Protected API routes — require both API secret AND valid user JWT ─────────
app.use("/api", requireApiKey, requireUser);
app.use("/api/accounts", accountsRouter);
app.use("/api/sync",     syncRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n✓ Pulse backend running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Mode:   ${process.env.NODE_ENV || "development"}\n`);
});

module.exports = app;
