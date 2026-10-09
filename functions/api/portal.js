import { json, services, getUser, siteUrl } from "../../lib/server.js";

// Opens Stripe's page where subscribers update their card or cancel.
export async function onRequestPost({ request, env }) {
  const s = services(env);
  const user = await getUser(request, s);
  if (!user) return json({ error: "Please sign in first." }, 401);
  const customer = user.app_metadata?.stripe_customer_id;
  if (!customer) return json({ error: "You do not have a subscription yet." }, 400);

  try {
    const portal = await s.stripe.billingPortal.sessions.create({ customer, return_url: siteUrl(request, env) });
    return json({ url: portal.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Could not open subscription settings. Please try again." }, 500);
  }
}
