import { json } from "../../lib/server.js";

// Public settings the page needs to start sign-in, show prices, and report Google Ads conversions.
// The Supabase anon key and Google Ads conversion labels are meant to be public.
export function onRequestGet({ env }) {
  return json({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    priceMonthly: env.PRICE_MONTHLY_LABEL || "$3.99",
    priceYearly: env.PRICE_YEARLY_LABEL || "$44.99",
    yearlySavings: env.YEARLY_SAVINGS_LABEL || "save 6%",
    ads: {
      id: env.GOOGLE_ADS_ID || "",
      signup: env.GOOGLE_ADS_SIGNUP_LABEL || "",
      subscribe: env.GOOGLE_ADS_SUBSCRIBE_LABEL || "",
      contact: env.GOOGLE_ADS_CONTACT_LABEL || "",
    },
  });
}
