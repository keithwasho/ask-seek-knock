// Shared server logic for the Cloudflare Pages Functions in /functions/api.
// Lives outside /functions so Cloudflare does not turn it into a route.
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Clients and settings for one request, built from the project's environment variables. */
export function services(rawEnv) {
  // Ignore stray spaces or line breaks pasted around any setting.
  const env = Object.fromEntries(
    Object.entries(rawEnv).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  );
  return {
    env,
    anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    stripe: new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }),
    db: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    freeTrialLimit: Number(env.FREE_TRIAL_LIMIT || 1),
    costCap: Number(env.MONTHLY_COST_CAP_USD || 3),
    prices: {
      monthly: env.STRIPE_PRICE_ID_MONTHLY || env.STRIPE_PRICE_ID,
      yearly: env.STRIPE_PRICE_ID_YEARLY,
    },
    portalHeadline: (env.PORTAL_HEADLINE || "SeekandKnock.com partners with Stripe for simple billing").slice(0, 60), // Stripe allows at most 60 characters
  };
}

/**
 * The Stripe billing page ("Manage subscription") is set up here in code, so nothing has to be configured
 * in the Stripe dashboard: headline, cancel at period end, card updates, switching between both plans,
 * invoice history, and Terms/Privacy links. A new setup is created automatically if the headline or site address changes.
 */
export async function portalConfiguration(s, site) {
  const terms = `${site}/terms`;
  const list = await s.stripe.billingPortal.configurations.list({ active: true, limit: 50 });
  const found = list.data.find(
    (c) =>
      c.metadata?.app === "ask-seek-knock" &&
      c.business_profile?.headline === s.portalHeadline &&
      c.business_profile?.terms_of_service_url === terms,
  );
  if (found) return found.id;

  // Group the prices by the product each belongs to (they may be on one product or two).
  const byProduct = new Map();
  for (const id of [s.prices.monthly, s.prices.yearly].filter(Boolean)) {
    const price = await s.stripe.prices.retrieve(id);
    const product = typeof price.product === "string" ? price.product : price.product.id;
    byProduct.set(product, [...(byProduct.get(product) || []), id]);
  }
  const products = [...byProduct].map(([product, prices]) => ({ product, prices }));
  const created = await s.stripe.billingPortal.configurations.create({
    business_profile: { headline: s.portalHeadline, terms_of_service_url: terms, privacy_policy_url: `${site}/privacy` },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products,
      },
    },
    metadata: { app: "ask-seek-knock" },
  });
  return created.id;
}

/* ---------- Cost tracking ---------- */

export const MODEL = "claude-opus-5-5";
export const MAX_TOKENS = 16000;

// Anthropic prices in USD per million tokens: [input, output]. A model not listed here
// (for example one a refusal fallback switched to) is charged at the highest rate, to stay safe.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
const TOP_PRICE = [10, 50];
const price = (model) => PRICES[model] || TOP_PRICE;

// The most one session could ever cost: a generous input plus a full-length answer at the highest rate (about $0.86).
// A subscriber may start a session only if their spend in the current 30-day window plus this amount stays
// within the cap, so their total can never pass it. Only successful answers are recorded.
export const SESSION_RESERVE_USD = (6000 * TOP_PRICE[0] + MAX_TOKENS * TOP_PRICE[1]) / 1e6;

/** What one Claude response actually cost, from the token counts it reports. */
export function sessionCost(response) {
  const usd = (u, model) => {
    const [inP, outP] = price(model);
    const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return (input * inP + (u.output_tokens || 0) * outP) / 1e6;
  };
  const total = usd(response.usage || {}, response.model);
  const parts = Array.isArray(response.usage?.iterations)
    ? response.usage.iterations.reduce((sum, it) => sum + usd(it, it.model || response.model), 0)
    : 0;
  return Math.max(total, parts); // when a fallback ran, count whichever figure is higher
}

const isLiveKey = (env) => /^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || "").trim());

/** Until Stripe has a live key, the real error is shown on the page to speed up setup. Never shown with live keys. */
export function testDetail(env, err) {
  if (isLiveKey(env)) return undefined;
  return String(err?.message || err).slice(0, 300);
}

/**
 * Checks the Stripe settings before calling Stripe and describes the first problem found, or returns null.
 * Only the first few characters of a value are ever shown. Returns null with live keys.
 */
export function stripeSetupProblem(env, plan) {
  if (isLiveKey(env)) return null;
  const start = (v) => (v ? `"${String(v).trim().slice(0, 8)}…"` : "empty");
  const key = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!key.startsWith("sk_test_")) {
    return `STRIPE_SECRET_KEY should be your Stripe test Secret key, starting with sk_test_. It currently starts with ${start(key)}.`;
  }
  const name = plan === "yearly" ? "STRIPE_PRICE_ID_YEARLY" : "STRIPE_PRICE_ID_MONTHLY";
  const price = String(env[name] || (plan === "monthly" ? env.STRIPE_PRICE_ID : "") || "").trim();
  if (!price.startsWith("price_")) {
    return `${name} should be a Stripe price ID starting with price_ (not the product ID, which starts with prod_). It currently starts with ${start(price)}.`;
  }
  return null;
}

export function siteUrl(request, env) {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

/** The signed-in Supabase user for this request, or null. */
export async function getUser(request, s) {
  const token = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await s.db.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

/** Sessions counted and dollars spent by this user since a date. */
async function usageSince(s, userId, since) {
  const { data, error } = await s.db
    .from("usage")
    .select("cost_usd, counted")
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());
  if (error) throw error;
  return {
    used: data.filter((r) => r.counted).length,
    spent: data.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0),
  };
}

// Test-mode and live-mode Stripe customers are stored separately, so switching keys at launch cannot break accounts.
const customerField = (s) => (isLiveKey(s.env) ? "stripe_customer_id" : "stripe_customer_id_test");

/** This user's Stripe customer ID for the current mode, or undefined. */
export function customerIdOf(s, user) {
  return user.app_metadata?.[customerField(s)];
}

/** The user's active Stripe subscription, or null. */
async function getSubscription(s, user) {
  const customer = customerIdOf(s, user);
  if (!customer) return null;
  try {
    const subs = await s.stripe.subscriptions.list({ customer, status: "all", limit: 10 });
    return subs.data.find((sub) => sub.status === "active" || sub.status === "trialing") || null;
  } catch (err) {
    if (err?.code === "resource_missing") return null; // customer was deleted in Stripe
    throw err;
  }
}

export async function isSubscribed(s, user) {
  return Boolean(await getSubscription(s, user));
}

// Stripe moved the billing period fields onto subscription items in newer API versions.
function billingPeriod(sub) {
  const item = sub.items?.data?.[0] || {};
  const start = sub.current_period_start ?? item.current_period_start;
  const end = sub.current_period_end ?? item.current_period_end;
  if (start && end) return { start: new Date(start * 1000), end: new Date(end * 1000) };
  const now = new Date(); // fallback: calendar month
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function planOf(sub) {
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval || sub.plan?.interval;
  return interval === "year" ? "yearly" : "monthly";
}

/**
 * The 30-day window the cost cap applies to.
 * Monthly plans use the billing month. Yearly plans use 30-day blocks counted from the start of the billing year.
 */
function costWindow(sub) {
  const period = billingPeriod(sub);
  if (planOf(sub) === "monthly") return period;
  const block = 30 * 24 * 60 * 60 * 1000;
  const n = Math.max(0, Math.floor((Date.now() - period.start.getTime()) / block));
  const start = new Date(period.start.getTime() + n * block);
  return { start, end: new Date(Math.min(start.getTime() + block, period.end.getTime())) };
}

/**
 * Whether this user may start a session now.
 * - Not subscribed: one free trial session, ever.
 * - Subscribed: no session limit. Behind the scenes, the account is paused for the rest of its 30-day window
 *   once another session could push what it has cost past costCap ($3.00 by default). This is never shown
 *   to the user: /api/me leaves it out and /api/ask just says "Please try again later."
 */
export async function getAllowance(s, user) {
  const sub = await getSubscription(s, user);
  if (sub) {
    const window = costWindow(sub);
    const { spent } = await usageSince(s, user.id, window.start);
    const paused = spent + SESSION_RESERVE_USD > s.costCap;
    return {
      subscribed: true,
      subscriptionId: sub.id,
      plan: planOf(sub),
      renewsAt: billingPeriod(sub).end.toISOString(),
      remaining: paused ? 0 : 1,
      paused,
      since: window.start,
    };
  }
  const since = new Date(0);
  const { used } = await usageSince(s, user.id, since);
  return {
    subscribed: false,
    limit: s.freeTrialLimit,
    used,
    paused: false,
    remaining: Math.max(0, s.freeTrialLimit - used),
    since,
  };
}

/**
 * Records one session, holding the worst-case cost until the real cost is known.
 * Returns the row id, or null if this would pass the free trial limit or the cost cap.
 */
export async function claimSession(s, user, allowance) {
  const { data, error } = await s.db
    .from("usage")
    .insert({ user_id: user.id, cost_usd: SESSION_RESERVE_USD, counted: true })
    .select("id")
    .single();
  if (error) throw error;
  // Re-check after inserting so two requests at once cannot both slip past a limit.
  const { used, spent } = await usageSince(s, user.id, allowance.since);
  if (allowance.subscribed ? spent > s.costCap : used > allowance.limit) {
    await releaseSession(s, data.id);
    return null;
  }
  return data.id;
}

/** Replaces the held worst-case cost with what a successful session really cost. */
export async function finishSession(s, id, costUsd) {
  const { error } = await s.db.from("usage").update({ cost_usd: costUsd, counted: true }).eq("id", id);
  if (error) throw error;
}

/** Removes a session that failed or came back incomplete, so it counts toward nothing. */
export async function releaseSession(s, id) {
  await s.db.from("usage").delete().eq("id", id);
}

export async function getOrCreateCustomer(s, user) {
  const existing = customerIdOf(s, user);
  if (existing) {
    try {
      const found = await s.stripe.customers.retrieve(existing);
      if (!found.deleted) return existing;
    } catch (err) {
      if (err?.code !== "resource_missing") throw err;
    }
  }
  const customer = await s.stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });
  const { error } = await s.db.auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, [customerField(s)]: customer.id },
  });
  if (error) throw new Error(`Could not save the Stripe customer to Supabase: ${error.message}`);
  return customer.id;
}

/* ---------- Owner alerts (new sign-ups and new subscribers) ---------- */

const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Emails the site owner through Resend. Uses the same secrets as the contact-form alert. Never throws. */
export async function sendOwnerAlert(env, subject, heading, rows) {
  const key = env.RESEND_API_KEY, to = env.CONTACT_NOTIFY_EMAIL, from = env.CONTACT_FROM_EMAIL;
  if (!key || !to || !from) {
    console.warn("Owner alert skipped: set RESEND_API_KEY, CONTACT_NOTIFY_EMAIL and CONTACT_FROM_EMAIL in Cloudflare.");
    return;
  }
  const text = `${heading}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nSeek & Knock";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1c2a4a">
      <h2 style="font-family:Georgia,serif;font-weight:normal;margin:0 0 14px">${escapeHtml(heading)}</h2>
      <table style="border-collapse:collapse;font-size:14px">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#5d6676;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0"><strong>${escapeHtml(v)}</strong></td></tr>`).join("")}
      </table>
      <p style="color:#5d6676;font-size:12px;margin-top:18px">Seek &amp; Knock owner alert. Details are also in Supabase (Authentication → Users) and Stripe.</p>
    </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `Seek & Knock Alerts <${from}>`, to: [to], subject, text, html }),
    });
    if (!res.ok) console.error(`Owner alert failed: Resend ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error("Owner alert failed:", err);
  }
}

export const when = (d) => new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

function locationOf(request) {
  const cf = request.cf || {};
  return [cf.city, cf.region, cf.country].filter(Boolean).join(", ") || "Unknown";
}

/** First-touch traffic source the page remembered (utm tags, ad click ids, or referring site). */
function sourceFrom(request) {
  try {
    const raw = request.headers.get("X-SK-Source");
    if (!raw || raw.length > 400) return null;
    const s = JSON.parse(raw);
    const clean = (v) => String(v || "").replace(/[^\w .:\/-]/g, "").slice(0, 60);
    return { source: clean(s.source), medium: clean(s.medium), campaign: clean(s.campaign), content: clean(s.content), referrer: clean(s.referrer) };
  } catch { return null; }
}

export function describeSource(src) {
  if (!src) return "Direct visit or unknown";
  const parts = [src.source, src.medium, src.campaign, src.content].filter(Boolean);
  if (parts.length) return parts.join(" / ");
  return src.referrer ? `Link from ${src.referrer}` : "Direct visit or unknown";
}

/**
 * Called whenever a signed-in visitor loads their account. Sends the owner one alert per new account
 * and one per new subscription. Marks the account first so repeat page loads never send duplicates.
 */
export async function notifyOwnerIfNew(s, user, allowance, request) {
  const meta = user.app_metadata || {};
  const updates = {};
  const alerts = [];
  const src = meta.source || sourceFrom(request);

  if (!meta.owner_notified_signup) {
    updates.owner_notified_signup = true;
    if (src && !meta.source) updates.source = src;
    // Only accounts created in the last 2 days, so existing users are not reported when this feature starts.
    if (Date.now() - Date.parse(user.created_at) < 2 * 24 * 60 * 60 * 1000) {
      alerts.push([
        `New Seek & Knock sign-up: ${user.email}`,
        "Someone just started a free trial",
        [["Email", user.email], ["Signed up", when(user.created_at)], ["Location (approx.)", locationOf(request)], ["Came from", describeSource(src)]],
      ]);
    }
  }

  if (allowance.subscribed && allowance.subscriptionId && meta.owner_notified_sub !== allowance.subscriptionId) {
    updates.owner_notified_sub = allowance.subscriptionId;
    const plan = allowance.plan === "yearly" ? "Yearly, $44.99/year" : "Monthly, $3.99/month";
    alerts.push([
      `New subscriber: ${user.email} (${allowance.plan === "yearly" ? "$44.99/yr" : "$3.99/mo"})`,
      "A new paid subscription just started",
      [["Email", user.email], ["Plan", plan], ["Renews", when(allowance.renewsAt)], ["Signed up", when(user.created_at)], ["Location (approx.)", locationOf(request)], ["Came from", describeSource(src)]],
    ]);
  }

  if (!Object.keys(updates).length) return;
  const { error } = await s.db.auth.admin.updateUserById(user.id, { app_metadata: { ...meta, ...updates } });
  if (error) { console.error("Could not mark owner alert as sent:", error.message); return; }
  for (const [subject, heading, rows] of alerts) await sendOwnerAlert(s.env, subject, heading, rows);
}