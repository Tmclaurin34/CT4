# Clicktide Shopify app — getting approved for many stores

Goal: any Shopify brand can install Clicktide (free audit + paid plans), not just one store.
App in the Dev Dashboard: **clicktide 3** (org 221453123, app 378037403649, 0 installs). Checked 2026-11-27.
Branch: `claude/determined-franklin-a83869`. **Nothing here is deployed or applied yet.**

---

## 1. What's built (tested, not deployed)

| Piece | Where | Tests |
|---|---|---|
| Order importer on GraphQL Admin API **2026-10** (REST 2024-01 is retired; new public apps must be GraphQL-only — requirement 2.2.4). Same order shape, same Shopify order ids (already-imported orders aren't double-counted), same paging/deadline/stats for nightly sync and the free audit. Throttle-aware; tolerates fields Shopify redacts. Reads only the 60 days Shopify allows until `read_all_orders` is approved, and the audit report says so. | `supabase/functions/platform-sync/shopify.js`, `index.ts` | `platform-sync/run_audit_tests.sh` → 33 audit + 21 mapping |
| **App URL** entry: verifies Shopify's signature, starts OAuth immediately on install and reinstall, never asks for a shop domain, opens the dashboard when already installed. | `supabase/functions/shopify-app` | shared helpers below |
| OAuth callback: constant-time signature check, rejects replayed links, GraphQL shop lookup. Installs that start on Shopify are saved **unclaimed** with a one-time claim token (only its SHA-256 is stored, 1-hour expiry); the merchant signs in or signs up and the dashboard attaches the store. | `supabase/functions/shopify-oauth-callback`, `shopify-claim` | SQL test 11 |
| Webhooks: `customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`, `app_subscriptions/update`. HMAC-verified on the raw body (401 if bad), each webhook id handled once, 200 within Shopify's 5 s, work done in the background, failures retried nightly. | `supabase/functions/shopify-webhooks` | shared helpers below |
| DB: webhook event log, redaction functions, data export, claim, Shopify billing columns + guard. | `supabase/migrations/20261128090000_shopify_public_app.sql` | `supabase/tests/run_shopify_tests.sh` → 19/19 (applied and tested inside a transaction that is always rolled back) |
| Shared logic: HMAC (webhook + OAuth), plan/subscription mapping, plan-page URL. | `supabase/functions/_shared/shopify.js` | `_shared/run_shopify_tests.sh` → 23/23 (HMAC vectors checked against Python) |
| Shopify billing, **switched off** by a flag (`SHOPIFY_BILLING_ENABLED`). While off it only logs what it would do. | `_shared/shopify_server.ts` | billing tests in both suites |

### What the deletion webhooks actually delete
- **customers/redact** — in every Clicktide business connected to that shop: the customer (matched by email, phone, or a listed order id) and their visit history, order ledger, rhythm, status events and send log. Gift shipments and SMS log rows are kept for billing totals but the name, email, address, phone and text are blanked. Survey answers, alerts and message events for that customer are deleted. A business **not** connected to that shop is never touched (tested).
- **shop/redact** (48 h after uninstall) — customers known *only* through Shopify are deleted as above. Customers the business also knows from another source (Square, check-in, CSV) keep their record but lose their Shopify order rows. The Shopify connection and token, the Shopify free-audit reports, and the Shopify subscription are removed/ended.
- **customers/data_request** — recorded and support@goclicktide.com is emailed the event number and the count of matching records (never the data itself). Support exports with `clicktide_shopify_customer_data(shop, email, phone)` and sends it to the merchant within 30 days.
- **app/uninstalled** — the connection is deactivated and the token blanked at once; data waits for shop/redact so a quick reinstall loses nothing.
- After processing a redact, the shopper's identifiers are wiped from the event log.

### Billing design (Shopify merchants via Shopify, everyone else via Stripe)
- Plans in Shopify App Pricing: Local $79 / Growth $199 / Scale $449, 30-day trial.
- Shopify App Pricing **stopped sending subscription webhooks after 2026-04-28**, so Clicktide re-reads the subscription (`currentAppInstallation.activeSubscriptions`) on install, on every app open, after claim, and nightly.
- It writes the **same columns the Stripe webhook writes** (`plan`, `stripe_subscription_status`, `stripe_current_period_end`), so every paywall check keeps working unchanged: ACTIVE in trial → `trialing`, ACTIVE → `active`, FROZEN → `unpaid`, PENDING → `incomplete`, cancelled/declined/expired/none → `canceled`. Plan by name, price as fallback; an unknown plan never unlocks anything.
- New columns `billing_provider`, `shopify_shop_domain`, `shopify_subscription_id`, `shopify_subscription_status` are server-only (browser writes are ignored, like the existing billing columns).
- Once a business is Shopify-billed, only the Shopify path can change its entitlement: a stray Stripe event can't overwrite it (tested). A business already paying through Stripe is never overridden by Shopify (tested; counted as a conflict).
- Test charges unlock Clicktide **only on development stores** (Shopify's reviewers use those), never on a real store.

---

## 2. Your steps in the Shopify Dev Dashboard (in order)

### Step 1 — Distribution → Public (unlisted)
Overview → **Select distribution method** → **Public**, limited visibility (install by link). Unlisted apps go through the same review and must bill through Shopify.

### Step 2 — New app version
Versions → **Create version**:

| Setting | Value |
|---|---|
| App URL | `https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-app` |
| Embedded | **Off.** Clicktide runs on goclicktide.com and isn't an App Bridge app. Shopify requires a resubmission if this changes later. |
| Legacy install flow | Off (unchanged) |
| Access scopes | `read_orders,read_customers` (add `read_all_orders` after Step 3 is approved) |
| Redirect URL | `https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-oauth-callback` (unchanged) |
| Webhooks API version | `2026-10` |
| Compliance webhooks (all 3) | `https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks` |
| Event webhooks | `app/uninstalled`, `app_subscriptions/update` → same URL |

If you use the Shopify CLI instead, the same thing in `shopify.app.toml`:
```toml
application_url = "https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-app"
embedded = false
[access_scopes]
scopes = "read_orders,read_customers"
[auth]
redirect_urls = ["https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-oauth-callback"]
[webhooks]
api_version = "2026-10"
  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks"
  [[webhooks.subscriptions]]
  topics = ["app/uninstalled", "app_subscriptions/update"]
  uri = "https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks"
```

**Scopes verdict:** `read_orders` + `read_customers` cover everything Clicktide reads (orders, the customer on each order, shipping address, shop name/id; the subscription query needs no scope). No write scopes are needed: discount codes are made by the merchant in Shopify. **But** `read_orders` only covers the **last 60 days**. The year of history the audit and first sync are built for needs `read_all_orders` (Step 3).

### Step 3 — Request "Read all orders"
Settings → Access requests → **Read all orders** → Request access. Paste:
> Clicktide learns each customer's normal repurchase interval from their order history and flags customers who are overdue. Many customers reorder every 4–12 weeks, so the default 60-day window shows at most one or two orders per customer and cannot establish a rhythm. Clicktide reads up to 12 months of orders, read-only, to compute per-customer intervals. It never creates, edits or cancels orders.

Until it's approved the importer reads 60 days and the free-audit report says so.

### Step 4 — Protected customer data
Settings → Access requests → Protected customer data → **Manage**. Request **Level 1** and the four Level 2 fields:

| Field | Reason (paste) |
|---|---|
| Level 1 (customer data) | To recognize repeat purchases by the same customer and calculate each customer's own reorder interval, which is the core of the app. |
| Name | To personalize the win-back email, text or postcard the merchant chooses to send, and so the merchant can recognize the customer in their dashboard. |
| Email | To tie orders to the same customer, and to send the merchant's win-back emails. Every email carries a working unsubscribe and Clicktide suppresses unsubscribed addresses. |
| Phone | To tie orders to the same customer when no email is present, and to send texts only to customers who opted in to SMS. |
| Address (shipping) | To mail the merchant's win-back postcards and gifts to the customer. Only US shipping addresses are kept; geolocation is not used. |

Data-use summary (paste):
> Clicktide is a customer-retention service for merchants. With read-only order access it identifies repeat customers, learns each one's usual reorder interval, and shows the merchant who is overdue. If the merchant subscribes and turns on campaigns, Clicktide sends the merchant's win-back email, opted-in text, mailed postcard or gift. The free audit stores only totals and deletes its per-customer working data as soon as the report is built. Customer data is never sold or shared for advertising. Merchants can disconnect and delete their data, and Clicktide honors customers/redact, customers/data_request and shop/redact.

**Data-protection questions: answer only what's true.** Status checked in the repo and database on 2026-11-27:

| Shopify asks | True today? | Notes / what to do before answering "yes" |
|---|---|---|
| Process minimum data | Yes | Only the 4 fields above, only US addresses kept |
| Tell merchants what's processed and why | **Partly** | Listing text says it; **privacy.html never mentions Shopify**. Add a short Shopify section (data read, why, retention, deletion) before submitting. |
| Use only for stated purposes | Yes | |
| Respect consent / opt-outs | Yes | SMS needs opt-in; email unsubscribe + suppression |
| Privacy & data agreements with merchants | Yes | terms.html accepted at signup (`legal_terms_accepted_at`) |
| Retention periods | **Partly** | Free-audit working data deleted after the report; deletions on redact/uninstall. **No automatic expiry** of a paying business's customers. State "kept while the merchant's account is active; deleted on request or 48 h after uninstall". |
| Encryption in transit | Yes | HTTPS everywhere |
| Encryption at rest | Yes (provider) | Supabase encrypts the database at rest. Shopify access tokens are stored in a normal column (not separately encrypted) and readable only by the server and that business's own login. |
| Encrypted backups | **No** | Supabase project is on the **free plan, no restorable backups**. Upgrade to Pro for daily encrypted backups, then answer yes. |
| Test vs production separation | Yes | Tests use synthetic rows inside always-rolled-back transactions |
| Data loss prevention | **Partly** | Per-business row-level security, server-only keys and billing columns. No written policy yet. |
| Limit staff access | Yes | One staff account (admin) |
| Strong staff passwords | **Partly** | Two-step login exists but **0 accounts have 2FA turned on**. Turn it on for the admin login, Supabase, Shopify and GitHub. |
| Access log of staff access to customer data | **No** | `clicktide_admin_audit_log` exists but has 0 rows; staff reads/edits aren't logged yet. |
| Security incident response policy | **No** | Adopt the draft in section 5 |

Shopify lets dev stores use the fields as soon as you save; real stores need approval. Without approval those fields come back empty (the importer then sees no email/phone and skips the order).

### Step 5 — Shopify App Pricing (Managed Pricing)
Partner Dashboard → Apps → clicktide 3 → Distribution → Manage listing → Pricing content → **Pricing method: Shopify App Pricing**. Create three monthly plans, **30-day free trial** each, names exactly:
- **Local** — $79 / month
- **Growth** — $199 / month
- **Scale** — $449 / month

Set the **welcome / post-approval link** to `https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-app`. Copy the **app handle** from the plan page URL (`admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`). It's needed as a secret (next section).

### Step 6 — Listing text (paste)
- **App name:** Clicktide
- **Tagline (short):** See which repeat customers stopped reordering, and win them back.
- **Description:**
  > Clicktide learns how often each of your customers normally reorders (coffee every three weeks, dog food every month) and shows you who has gone quiet before they're gone for good. Connect your store read-only and get a free report: how many customers are drifting, what they've spent with you, and who to win back first. If you choose, Clicktide brings them back automatically with a personal email, an opted-in text, a real mailed postcard or a small gift, and counts recovered revenue only when a customer actually orders again. Plans from $79/month with a 30-day free trial, billed through Shopify.
- **Key benefits:** Per-customer reorder rhythm (not one fixed timer) · Free drift report from your own orders · Email, opted-in SMS, postcards and gifts in one place · Recovered revenue you can verify
- **Support:** support@goclicktide.com · **Privacy policy:** https://goclicktide.com/privacy.html · **Terms:** https://goclicktide.com/terms.html
- **Icon:** 1200×1200 PNG from the Clicktide logo.

### Step 7 — Housekeeping
- Two client secrets exist (old + Jun 6). After confirming the live `SHOPIFY_CLIENT_SECRET` in Supabase is the new one, **revoke the old one**.
- Keep IP allowlist off (Supabase functions have no fixed IP).

---

## 3. What Claude does after your OK (in this order)

1. **Apply the migration** `20261128090000_shopify_public_app.sql` (re-run `supabase/tests/run_shopify_tests.sh` first).
2. **Set secrets** in Supabase: `SHOPIFY_APP_HANDLE=<handle from Step 5>`. Check `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are present. Leave `SHOPIFY_BILLING_ENABLED` unset.
3. **Deploy** (download and diff each live function first, since other sessions deploy here):
   - `shopify-webhooks`, `shopify-app`: verify_jwt **off** (Shopify's signature is the auth)
   - `shopify-oauth-callback`: verify_jwt off (unchanged)
   - `shopify-claim`: verify_jwt **on**
   - `platform-sync`: bundle `index.ts`, `audit.js`, `shopify.js`
   - every Shopify function also bundles `_shared/shopify.js` + `_shared/shopify_server.ts`
4. **Nightly job** for webhook retries + billing reconcile:
   ```sql
   select cron.schedule('clicktide-shopify-nightly', '40 6 * * *', $$
     select net.http_post(
       url := 'https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-clicktide-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'CAMPAIGN_RUNNER_KEY')),
       body := '{}'::jsonb)
   $$);
   ```
   (Same key and form as the live `clicktide-platform-sync` job.)
5. **Dashboard changes in `index.html`** (not done here; that file was off-limits for this task):
   - On load, if the URL has `ct_shopify_claim`: keep it through sign-in/sign-up, then
     `fetch(FN + "/shopify-claim", {method:"POST", headers:{...h(S.token)}, body: JSON.stringify({claim})})`, show "Shopify store connected", and remove it from the URL.
   - Replace the "enter your .myshopify.com domain" Connect Shopify box (forbidden by rule 2.3.1) with a button to the app's install link.
   - Businesses with `billing_provider = 'shopify'` or a Shopify connection: "Choose plan" opens `admin.shopify.com/store/<store>/charges/<handle>/pricing_plans` instead of Stripe Checkout, and "Manage billing" goes there too (no Stripe portal).
6. **Test on a development store** end to end: install from the link, OAuth, sign up, claim, import, plan selection (test charge), open from the Shopify admin, uninstall, then `shopify app webhook trigger` for each compliance topic.
7. **Turn billing on** (`SHOPIFY_BILLING_ENABLED=true`) only after step 6 passes and your OK.
8. Then submit for review.

---

## 4. Review checklist

- [ ] Distribution Public (unlisted), new version with the values in Step 2, embedded off
- [ ] Install from the link starts OAuth immediately; no shop-domain box anywhere
- [ ] After approving, the merchant lands in Clicktide (signup/login, then dashboard)
- [ ] Reinstall after uninstall runs OAuth again
- [ ] All 3 compliance webhooks return 200 for valid HMAC and **401** for invalid
- [ ] `app/uninstalled` stops syncing
- [ ] Shopify App Pricing plans live; dev-store test subscription unlocks the plan; no Stripe checkout shown to Shopify merchants
- [ ] Protected customer data (Level 1 + name/email/phone/address) approved; `read_all_orders` requested
- [ ] Only GraphQL Admin API calls, version 2026-10 (no REST anywhere in Shopify code)
- [ ] Privacy policy URL, support email and listing text filled
- [ ] Data-protection answers match section 2 Step 4 (fix backups, 2FA, access log, incident policy first, or answer honestly)
- [ ] Screencast for reviewers: install → OAuth → signup → claim → free report → plan selection

---

## 5. Incident response policy (draft to adopt)

1. **Report:** anyone who suspects unauthorized access or data exposure emails support@goclicktide.com right away; the owner records the time, what was seen and which systems.
2. **Contain (within 1 hour):** rotate affected keys (Supabase service key, Shopify client secret, provider tokens) and disable affected accounts or connections.
3. **Assess (within 24 hours):** work out which data, merchants and customers were affected, from database and provider logs.
4. **Notify:** affected merchants within 72 hours, Shopify when Shopify data is involved, and anyone else breach laws require.
5. **Recover and review:** fix the cause, restore from backup if needed, write a short review within 7 days.

Severity: **High** = shopper contact data exposed · **Medium** = merchant business data exposed · **Low** = no personal data.

---

## 6. Known gaps and follow-ups
- Shopify access tokens are stored as plain text, and a business's own login can read its token (row-level security allows reading your own connection). Move tokens to Supabase Vault or a server-only table before scale.
- The free-audit pull uses paginated queries (Shopify caps those at 25,000 objects). Very large stores should move to bulk operations.
- The existing Clicktide onboarding flow for logged-out users keeps the OAuth state only in the browser, so the callback can't save that connection (it now tells the user instead of claiming success). The Shopify-side install path above replaces it for Shopify.

Sources: [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) · [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance) · [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) · [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/managed-pricing) · [Access scopes](https://shopify.dev/docs/api/usage/access-scopes) · [Versioning](https://shopify.dev/docs/api/usage/versioning)
