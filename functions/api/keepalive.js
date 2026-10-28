import { createClient } from "@supabase/supabase-js";
import { json } from "../../lib/server.js";

// Runs one tiny database read so Supabase sees activity and does not pause the free project.
// Called every few days by .github/workflows/supabase-keepalive.yml. Returns no data, only ok or not.
export async function onRequestGet({ env }) {
  const db = createClient(String(env.SUPABASE_URL).trim(), String(env.SUPABASE_SERVICE_ROLE_KEY).trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.from("usage").select("id", { head: true, count: "exact" }).limit(1);
  if (error) {
    console.error("Keep-alive query failed:", error);
    return json({ ok: false }, 500);
  }
  return json({ ok: true });
}
