// Supabase connection details. Committed on purpose.
//
// The key below is publishable. It is delivered to every browser that loads the app, so
// hiding it behind a gitignore was never protection, it only would have broken the static
// deploy. Every request carrying it runs as the anon or authenticated role, and row-level
// security decides which rows those roles can see. RLS is the protection. No RLS means no
// protection, gitignore or not.
//
// What must never reach this file, or anywhere else the browser can read: the secret key
// (sb_secret_...) or the legacy service_role JWT. Those bypass every RLS policy. Server side
// environment variables only.
//
// TODO before step 3: this is a legacy anon JWT. Legacy anon and service_role keys are
// deprecated at the end of 2026. Generate a publishable key in the dashboard under Project
// Settings, API Keys, rename this export to SUPABASE_PUBLISHABLE_KEY, and paste it in. The new
// formats also let the gateway reject a secret key arriving from something that looks like a
// browser, which the legacy JWTs cannot do.
//
// Nothing imports this yet. The app is IndexedDB only until step 4 of the build order.

export const SUPABASE_URL = "https://dhybzlcjdavsawrmsfte.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRoeWJ6bGNqZGF2c2F3cm1zZnRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MTY3MzAsImV4cCI6MjEwMTI5MjczMH0._dP6ryv5Im6y3VVv8Kt4soxNHMrHB3lURSoRfhzplhk";