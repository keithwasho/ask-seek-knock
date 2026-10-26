import { json, services, siteUrl, testDetail } from "../../lib/server.js";

// Starts a one-time Stripe Checkout for a personalized set of two acacia wood coasters.
// No sign-in needed. The price and shipping come from wrangler.toml (COASTER_PRICE_USD, COASTER_SHIPPING_USD).
// The engraving details are saved on the Stripe payment (metadata) and emailed to the owner by /api/stripe-webhook.
const OCCASIONS = ["Baptism", "Confirmation", "Sacrament of Marriage"];

const cents = (v, fallback) => {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const clean = (v, max) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  const s = services(env);
  const body = await request.json().catch(() => ({}));

  const name = clean(body?.name, 40);
  const occasion = OCCASIONS.includes(body?.occasion) ? body.occasion : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date || "") ? body.date : "";
  if (!name || !occasion || !date) {
    return json({ error: "Please enter the name, the date, and choose the occasion." }, 400);
  }
  const shownDate = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  const engraving = `${name} · ${occasion} · ${shownDate}`;
  const details = { product: "coasters", engrave_name: name, engrave_occasion: occasion, engrave_date: shownDate, engrave_date_iso: date };

  if (!String(s.env.STRIPE_SECRET_KEY || "").startsWith("sk_")) {
    return json({ error: "Could not start checkout. Please try again.", detail: "STRIPE_SECRET_KEY is not set." }, 500);
  }

  try {
    const site = siteUrl(request, s.env);
    const session = await s.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: 10 },
        price_data: {
          currency: "usd",
          unit_amount: cents(s.env.COASTER_PRICE_USD, 3499),
          product_data: {
            name: "Personalized Genuine Acacia Wood Coasters (set of 2)",
            description: `Engraved: ${engraving}`,
          },
        },
      }],
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: "US shipping (USPS Ground Advantage)",
          fixed_amount: { amount: cents(s.env.COASTER_SHIPPING_USD, 699), currency: "usd" },
          delivery_estimate: { minimum: { unit: "business_day", value: 7 }, maximum: { unit: "business_day", value: 14 } },
        },
      }],
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      metadata: details,
      payment_intent_data: { description: `Acacia wood coasters: ${engraving}`, metadata: details },
      success_url: `${site}/coasters?ordered=1`,
      cancel_url: `${site}/coasters`,
    });
    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Could not start checkout. Please try again.", detail: testDetail(s.env, err) }, 500);
  }
}
