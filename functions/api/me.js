import { json, services, getUser, getAllowance, notifyOwnerIfNew } from "../../lib/server.js";

export async function onRequestGet({ request, env, waitUntil }) {
  const s = services(env);
  const user = await getUser(request, s);
  if (!user) return json({ error: "Please sign in." }, 401);
  try {
    const a = await getAllowance(s, user);

    // Email the owner about a new sign-up or new subscriber, after the response is sent.
    const alert = notifyOwnerIfNew(s, user, a, request).catch((err) => console.error("Owner alert error:", err));
    if (typeof waitUntil === "function") waitUntil(alert); else await alert;

    // The cost limit stays private: subscribers only see their plan and renewal date.
    return json(
      a.subscribed
        ? { email: user.email, subscribed: true, plan: a.plan, renewsAt: a.renewsAt }
        : { email: user.email, subscribed: false, remaining: a.remaining },
    );
  } catch (err) {
    console.error(err);
    return json({ error: "Could not load your account. Please try again." }, 500);
  }
}
