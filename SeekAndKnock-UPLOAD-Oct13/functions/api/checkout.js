import {
  json, services, getUser, isSubscribed, getOrCreateCustomer, siteUrl, testDetail, stripeSetupProblem, portalConfiguration,
} from "../../lib/server.js";

// Starts Stripe Checkout for the monthly ($4.99) or yearly ($54) plan,
// or sends existing subscribers to manage their plan.
export async function onRequestPost({ request, env }) {
  const s = services(env);
  const user = await getUser(request, s);
  if (!user) return json({ error: "Please sign in first." }, 401);

  const body = await request.json().catch(() => ({}));
  const plan = body?.plan === "yearly" ? "yearly" : "monthly";

  const problem = stripeSetupProblem(s.env, plan);
  if (problem) return json({ error: "Could not start checkout. Please try again.", detail: problem }, 500);

  const price = s.prices[plan];
  if (!price) return json({ error: "That plan is not available right now." }, 400);

  try {
    const customer = await getOrCreateCustomer(s, user);
    const site = siteUrl(request, s.env);
    if (await isSubscribed(s, user)) {
      const portal = await s.stripe.billingPortal.sessions.create({
        customer,
        return_url: site,
        configuration: await portalConfiguration(s, site),
      });
      return json({ url: portal.url });
    }
    const session = await s.stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${site}/?subscribed=1`,
      cancel_url: site,
    });
    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Could not start checkout. Please try again.", detail: testDetail(s.env, err) }, 500);
  }
}
