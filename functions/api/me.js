import { json, services, getUser, getAllowance } from "../../lib/server.js";

export async function onRequestGet({ request, env }) {
  const s = services(env);
  const user = await getUser(request, s);
  if (!user) return json({ error: "Please sign in." }, 401);
  try {
    const a = await getAllowance(s, user);
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
