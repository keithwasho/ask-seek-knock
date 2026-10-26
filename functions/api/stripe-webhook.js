import Stripe from "stripe";
import { services, sendOwnerAlert, when, describeSource } from "../../lib/server.js";

// Stripe calls this address when a subscription changes or a coaster order is paid. It emails the owner when a
// subscriber cancels, resumes, or their subscription ends, and sends each coaster order with its engraving and
// shipping address. Set up in Stripe: Developers -> Webhooks -> endpoint https://seekandknock.com/api/stripe-webhook,
// events customer.subscription.updated, customer.subscription.deleted and checkout.session.completed. Put the endpoint's signing secret in Cloudflare as STRIPE_WEBHOOK_SECRET.
export async function onRequestPost({ request, env, waitUntil }) {
  const s = services(env);
  const secret = s.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("STRIPE_WEBHOOK_SECRET is not set", { status: 500 });

  const body = await request.text();
  let event;
  try {
    event = await s.stripe.webhooks.constructEventAsync(
      body,
      request.headers.get("stripe-signature"),
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    return new Response(`Signature check failed: ${err.message}`, { status: 400 });
  }

  const work = handleEvent(s, event).catch((err) => console.error("Stripe webhook alert error:", err));
  if (typeof waitUntil === "function") waitUntil(work); else await work;
  return new Response("ok");
}

async function handleEvent(s, event) {
  if (event.type === "checkout.session.completed") return coasterOrder(s, event.data.object);
  const sub = event.data?.object;
  if (!sub || sub.object !== "subscription") return;
  const before = event.data.previous_attributes || {};

  let kind = null;
  if (event.type === "customer.subscription.deleted") kind = "ended";
  else if (event.type === "customer.subscription.updated") {
    const nowCanceling = Boolean(sub.cancel_at_period_end || sub.cancel_at);
    const wasCanceling = "cancel_at_period_end" in before || "cancel_at" in before
      ? Boolean(before.cancel_at_period_end || before.cancel_at)
      : nowCanceling;
    if (nowCanceling && !wasCanceling) kind = "canceled";
    else if (!nowCanceling && wasCanceling) kind = "resumed";
  }
  if (!kind) return;

  // Who is it?
  const customer = typeof sub.customer === "string" ? await s.stripe.customers.retrieve(sub.customer) : sub.customer;
  const email = (customer && !customer.deleted && customer.email) || "Unknown email";
  let source = null, signedUp = null;
  const userId = customer && !customer.deleted ? customer.metadata?.supabase_user_id : null;
  if (userId) {
    const { data } = await s.db.auth.admin.getUserById(userId);
    source = data?.user?.app_metadata?.source || null;
    signedUp = data?.user?.created_at || null;
  }

  const item = sub.items?.data?.[0] || {};
  const yearly = item.price?.recurring?.interval === "year";
  const plan = yearly ? "Yearly, $44.99/year" : "Monthly, $3.99/month";
  const periodEnd = sub.current_period_end ?? item.current_period_end;
  const accessUntil = sub.cancel_at || periodEnd;
  const reason = [sub.cancellation_details?.feedback, sub.cancellation_details?.comment].filter(Boolean).join(" · ");

  const rows = [["Email", email], ["Plan", plan], ["Subscribed since", when(sub.start_date * 1000)]];
  if (signedUp) rows.push(["First signed up", when(signedUp)]);
  rows.push(["Came from", describeSource(source)]);

  if (kind === "canceled") {
    if (accessUntil) rows.splice(2, 0, ["Access until", when(accessUntil * 1000)]);
    if (reason) rows.push(["Reason given", reason]);
    await sendOwnerAlert(s.env, `Subscriber canceled: ${email}`, "A subscriber canceled (access continues until the end of their paid period)", rows);
  } else if (kind === "resumed") {
    await sendOwnerAlert(s.env, `Subscriber resumed: ${email}`, "A subscriber undid their cancellation and will keep renewing", rows);
  } else {
    if (reason) rows.push(["Reason given", reason]);
    await sendOwnerAlert(s.env, `Subscription ended: ${email}`, "A subscription has fully ended and will no longer renew", rows);
  }
}

/** Emails the owner everything needed to engrave and ship a paid coaster order. */
async function coasterOrder(s, session) {
  const m = session?.metadata || {};
  if (m.product !== "coasters") return;
  const items = await s.stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
  const sets = items.data.reduce((n, i) => n + (i.quantity || 0), 0) || 1;
  const ship = session.collected_information?.shipping_details || session.shipping_details || {};
  const a = ship.address || {};
  const address = [ship.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");
  const buyer = session.customer_details || {};
  const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;
  const rows = [
    ["Engrave name", m.engrave_name],
    ["Occasion", m.engrave_occasion],
    ["Date", m.engrave_date],
    ["Sets of 2", String(sets)],
    ["Ship to", address || "See Stripe"],
    ["Buyer", [buyer.name, buyer.email, buyer.phone].filter(Boolean).join(" · ") || "See Stripe"],
    ["Paid", `${money(session.amount_total)} (shipping ${money(session.total_details?.amount_shipping)})`],
    ["Ordered", when(session.created * 1000)],
  ];
  await sendOwnerAlert(s.env, `Coaster order: ${m.engrave_name} (${m.engrave_occasion})`, "New acacia wood coaster order to engrave and ship", rows);
}
