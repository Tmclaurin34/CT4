# Clicktide: testing instructions for Shopify App Review

Paste the "For the reviewer" section into the submission's testing-instructions field. The checklist at the end is for us, before submitting.

---

## For the reviewer

**What Clicktide does:** Clicktide reads a store's orders (read-only), learns how often each customer normally reorders, and shows who has gone quiet compared with their own pattern. The merchant can turn on win-back messages: email, opted-in text, mailed postcard or branded gift. Nothing is sent until a campaign is switched on.

**Clicktide is a non-embedded app.** Opening it from the Shopify admin opens goclicktide.com in the browser, already signed in to the store's Clicktide account. No separate sign-up, password or test account is needed.

### 1. Install
1. Install Clicktide on your development store and approve read-only access to orders and customers.
2. Shopify sends you to goclicktide.com. Clicktide creates the store's account automatically and asks **"Open Clicktide for the Shopify store your-store.myshopify.com?"** (a sign-in safety check). Click **Open Clicktide**. The dashboard opens.

### 2. Choose a plan (Shopify billing)
- The dashboard shows **Choose a plan**. It opens Shopify's plan page: Local, Growth or Scale, each with a 30-day free trial. On a development store this is a $0 test charge.
- After approving, Shopify returns you to Clicktide. Plan changes are made on the same Shopify page (Settings → Manage subscription in Clicktide also links there).

### 3. See it working
- **Import:** Clicktide imports the store's orders and customers in the background (recent 30 days first, then up to a year). Customers with no email or phone are counted but can't be messaged.
- **Overview and Customers:** each customer's usual reorder rhythm and status (healthy, drifting, at risk, recovered). A personal rhythm needs at least 2 orders from that customer.
- **Campaigns:** the Win-Back Playbook or the campaign builder. Emails start 48 hours after a store is first connected. Texts need carrier registration (Settings → Business texting) and customers who opted in.
- **Postcards and gifts** are physical items billed as Shopify usage charges. Clicktide never bills usage on development stores or during the free trial, so these sends are refused there. Email works fully.

### 4. Open again from the Shopify admin
- Apps → Clicktide opens goclicktide.com signed in. No reinstall and no permissions screen.

### 5. Uninstall and privacy
- Uninstalling stops syncing immediately (token wiped, connection deactivated).
- `shop/redact` (48 hours later) deletes the store's data, including the Clicktide account made for the store, unless the app was reinstalled.
- `customers/redact` deletes that shopper; `customers/data_request` is fulfilled to the merchant within 30 days.
- Privacy policy: https://goclicktide.com/privacy. Support: support@goclicktide.com.

### Scopes
| Scope | Why |
|---|---|
| `read_orders` | Order dates and totals are how Clicktide learns each customer's reorder rhythm. |
| `read_customers` | Name, email and address so the merchant can win back their own customers (email, postcard, gift). |
| `read_all_orders` | A year of history so rhythms work for customers who reorder less often than every 60 days. |

No write scopes: Clicktide never changes products, prices, orders or customers in the store.

---

## Our pre-submission checklist

| Item | Status |
|---|---|
| Install link → grant → claim (tested on clicktide-test) | Done 2026-11-27 |
| Expiring offline tokens + refresh | Done, verified live |
| Import via GraphQL 2026-10, backdated dates, rhythms learned | Done |
| Open from admin → Overview | Done |
| Compliance webhooks registered and HMAC-verified (shop/redact, customers/redact) | Done |
| Re-sync after full seed: lapsed → drifting, returners → back, 3 email opt-outs imported | To do |
| Uninstall → token wiped; reinstall → claim again | To do |
| $19 App Store registration | Waiting on owner |
| Managed Pricing: Local $79 / Growth $199 / Scale $449, 30-day trial; confirm app handle | After registration |
| Turn on `SHOPIFY_BILLING_ENABLED=true`, then test charge on the dev store | After pricing |
| Listing: name, tagline, description, screenshots (3+, 1600×900), icon | Icon uploaded; screenshots after the full seed |
| Protected customer data: 16/16 answered, requirements met | Done (submits with the app) |
