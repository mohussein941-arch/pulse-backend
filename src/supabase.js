const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.\n" +
    "Copy .env.example to .env and fill in your Supabase credentials."
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
  }
);

module.exports = supabase;
