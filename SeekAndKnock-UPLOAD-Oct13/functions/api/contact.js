import { json, services } from "../../lib/server.js";

// Saves a "Contact us" message to the contact_messages table in Supabase, then emails an alert through Resend.
// Read all submissions in Supabase: Table Editor -> contact_messages.
//
// Cloudflare secrets used for the email alert:
//   RESEND_API_KEY        Resend API key (re_...)
//   CONTACT_NOTIFY_EMAIL  where alerts are sent (your private inbox; never shown on the site)
//   CONTACT_FROM_EMAIL    sender on your Resend-verified domain, e.g. hello@seekandknock.com
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
  } catch (err) {
    console.error(err);
    return json({ error: "Your message could not be sent right now. Please try again in a few minutes." }, 500);
  }

  // The message is saved. The email alert is a bonus: if it fails, the visitor still sees success
  // and the message is still in Supabase.
  await sendAlert(s.env, { name, email, message }).catch((err) => console.error("Contact alert email failed:", err));
  return json({ ok: true });
}

const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sendAlert(env, { name, email, message }) {
  const key = env.RESEND_API_KEY;
  const to = env.CONTACT_NOTIFY_EMAIL;
  const from = env.CONTACT_FROM_EMAIL;
  if (!key || !to || !from) {
    console.warn("Contact alert skipped: set RESEND_API_KEY, CONTACT_NOTIFY_EMAIL and CONTACT_FROM_EMAIL in Cloudflare.");
    return;
  }
  const when = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  const subject = `New Contact Us message from ${name.replace(/[\r\n]+/g, " ").slice(0, 60)}`;
  const text = `New message from the Seek & Knock contact form (${when} Eastern)\n\nName: ${name}\nEmail: ${email}\n\n${message}\n\nReply to this email to answer ${name} directly.\nAll messages: Supabase > Table Editor > contact_messages`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1c2a4a">
      <h2 style="font-family:Georgia,serif;font-weight:normal;margin:0 0 4px">New Contact Us message</h2>
      <p style="color:#5d6676;margin:0 0 18px;font-size:13px">${escapeHtml(when)} Eastern · Seek &amp; Knock</p>
      <p style="margin:0 0 4px"><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p style="margin:0 0 16px"><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <div style="background:#faf7f1;border-left:3px solid #c08a3e;padding:14px 16px;white-space:pre-wrap;line-height:1.5">${escapeHtml(message)}</div>
      <p style="color:#5d6676;font-size:13px;margin-top:18px">Click <strong>Reply</strong> to answer ${escapeHtml(name)} directly. All messages are also saved in Supabase → Table Editor → contact_messages.</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Seek & Knock Contact <${from}>`,
      to: [to],
      reply_to: email,
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
