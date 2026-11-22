import { createClient } from "@supabase/supabase-js";
import { json } from "../../lib/server.js";

// Keeps the free Supabase project from pausing for inactivity.
// Called several times a day by .github/workflows/supabase-keepalive.yml. Returns no data, only ok or not.
// A single row-count (HEAD) request was not enough: Supabase still flagged the project as inactive on 2026-11-22.
// So each call now does real reads that return rows, against both the database and sign-in (auth).
export async function onRequestGet({ env }) {
  const db = createClient(String(env.SUPABASE_URL).trim(), String(env.SUPABASE_SERVICE_ROLE_KEY).trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const results = await Promise.all([
    db.from("usage").select("id, created_at").order("id", { ascending: false }).limit(5),
    db.from("contact_messages").select("id, created_at").order("id", { ascending: false }).limit(5),
    db.auth.admin.listUsers({ page: 1, perPage: 5 }),
  ]);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.error("Keep-alive query failed:", failed.map((r) => r.error));
    return json({ ok: false }, 500);
  }
  return json({ ok: true });
}
