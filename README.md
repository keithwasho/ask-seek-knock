# Ask, Seek, and Knock

A one-page website. Visitors write what they are going through and get an answer grounded in the New American Bible, Revised Edition (NABRE), the Catechism of the Catholic Church, and papal encyclicals, with every source cited.

**Pricing built in**
- Every new visitor gets **1 free trial session** after signing in with their email.
- After that, subscribers pay **$4.99/month or $54/year (save 10%)** with no session limit.
- **Hidden cost cap:** the real Claude cost of every successful answer is recorded. Failed or incomplete answers are not recorded and count toward nothing. A subscriber can start a session only if what they have cost in the current 30-day window, plus the most one answer could possibly cost (about $0.86), stays within `MONTHLY_COST_CAP_USD` ($4.50). Otherwise they see only "Please try again later." until the next window starts. The cap is never shown to users.
  - Monthly plans: the window is the billing month.
  - Yearly plans: 30-day blocks counted from the start of the billing year.

**Folders**
- `public/index.html`: the page visitors see. `public/terms.html` and `public/privacy.html`: starter legal pages (replace every YOUR-… placeholder before launch).
- `functions/api/`: server routes (`/api/ask`, `/api/me`, `/api/checkout`, `/api/portal`, `/api/config`).
- `lib/server.js`: shared logic (sign-in check, session counting, Stripe).
- `wrangler.toml`: Cloudflare settings and the limits above.
- `supabase.sql`: run once in Supabase to create the usage table.

**Services:** Cloudflare Pages (hosting, free, commercial use allowed), Supabase (sign-in + database, free), Stripe (payments), Anthropic (answers), Resend (sign-in emails, free).

## Cloudflare settings

When you create the Pages project from GitHub:
- Framework preset: **None**
- Build command: `npm install`
- Build output directory: `public`

Add these under **Settings → Variables and Secrets**, each as type **Secret**, for **Production** (and **Preview** if you use preview links):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` while testing, `sk_live_…` at launch) |
| `STRIPE_PRICE_ID_MONTHLY` | Stripe price ID for $4.99/month (`price_…`) |
| `STRIPE_PRICE_ID_YEARLY` | Stripe price ID for $54/year (`price_…`) |
| `SITE_URL` | your site address, e.g. `https://ask-seek-knock.pages.dev` |

After adding or changing secrets, go to **Deployments** and **Retry deployment** on the latest one so they take effect.

In Stripe, create one product with two prices: **$4.99 recurring monthly** and **$54 recurring yearly**. To let subscribers switch between plans, add both prices under **Settings → Billing → Customer portal → Products**.

To change the free trial count, cost cap, or price labels, edit `wrangler.toml` on GitHub; Cloudflare redeploys automatically.

## If something fails

Open the Pages project → **Deployments** → the latest deployment → **Functions** / **Real-time logs**, ask a question on the site, and copy any red error lines.

If the logs say a request **exceeded its CPU time limit**, upgrade to Cloudflare **Workers Paid ($5/month)**, which raises the limit. Time spent waiting for Claude does not count toward this limit, so the free plan is expected to be enough.
