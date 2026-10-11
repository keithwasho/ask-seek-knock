import { json, services, getUser, siteUrl, testDetail, customerIdOf, portalConfiguration } from "../../lib/server.js";

// Opens Stripe's page where subscribers update their card, switch plans, or cancel.
export async function onRequestPost({ request, env }) {
  const s = services(env);
  const user = await getUser(request, s);
  if (!user) return json({ error: "Please sign in first." }, 401);
  const customer = customerIdOf(s, user);
  if (!customer) return json({ error: "You do not have a subscription yet." }, 400);

  try {
    const site = siteUrl(request, s.env);
    const portal = await s.stripe.billingPortal.sessions.create({
      customer,
      return_url: site,
      configuration: await portalConfiguration(s, site),
    });
    return json({ url: portal.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Could not open subscription settings. Please try again.", detail: testDetail(s.env, err) }, 500);
  }
}
