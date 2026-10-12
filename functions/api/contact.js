import { json, services } from "../../lib/server.js";

// Saves a "Contact us" message to the contact_messages table in Supabase.
// Read submissions in Supabase: Table Editor -> contact_messages.
const MAX = { name: 100, email: 200, message: 4000 };
const PER_HOUR = 5; // messages allowed from one internet address per hour

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));

  // Hidden "website" field: people never see it, spam bots fill it in. Pretend success and save nothing.
  if (body.website) return json({ ok: true });

  const name = String(body.name || "").trim().slice(0, MAX.name);
  const email = String(body.email || "").trim().slice(0, MAX.email);
  const message = String(body.message || "").trim().slice(0, MAX.message);
  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please enter your name, a valid email address, and your message." }, 400);
  }

  const s = services(env);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  try {
    if (ip) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error } = await s.db
        .from("contact_messages")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("created_at", since);
      if (error) throw error;
      if ((count || 0) >= PER_HOUR) {
        return json({ error: "We have received several messages from you in the last hour. Please try again later." }, 429);
      }
    }
    const { error } = await s.db.from("contact_messages").insert({ name, email, message, ip });
    if (error) throw error;
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: "Your message could not be sent right now. Please try again in a few minutes." }, 500);
  }
}
