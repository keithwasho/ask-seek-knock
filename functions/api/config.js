import { json } from "../../lib/server.js";

// Public settings the page needs to start sign-in and show prices. The Supabase anon key is meant to be public.
export function onRequestGet({ env }) {
  return json({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    priceMonthly: env.PRICE_MONTHLY_LABEL || "$4.99",
    priceYearly: env.PRICE_YEARLY_LABEL || "$54",
    yearlySavings: env.YEARLY_SAVINGS_LABEL || "save 10%",
  });
}
