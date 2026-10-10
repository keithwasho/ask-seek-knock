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
    costCap: Number(env.MONTHLY_COST_CAP_USD || 4.5),
    prices: {
      monthly: env.STRIPE_PRICE_ID_MONTHLY || env.STRIPE_PRICE_ID,
      yearly: env.STRIPE_PRICE_ID_YEARLY,
    },
  };
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
 *   once another session could push what it has cost past costCap ($4.50 by default). This is never shown
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
