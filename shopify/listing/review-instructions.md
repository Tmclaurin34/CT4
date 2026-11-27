# Clicktide: testing instructions for Shopify App Review

Paste the "For the reviewer" section into the submission's testing-instructions field. The checklist at the end is for us, before submitting.

---

## For the reviewer

**What Clicktide does:** Clicktide reads a store's orders, read-only. It learns how often each customer normally reorders, and it shows which customers have gone quiet compared with their own rhythm. The merchant can then turn on win-back messages: email, opted-in SMS, a mailed postcard or a small gift. Clicktide counts recovered revenue only when a customer actually orders again.

**Clicktide is embedded in the Shopify admin** (App Bridge, session tokens, Shopify-managed install). The admin page shows each store's drifting customers; the full dashboard (campaigns, customer history) opens at goclicktide.com from a button on that page.

### 1. Install and connect
1. Install Clicktide from the listing on your development store and approve read-only access to orders and customers. Shopify opens Clicktide inside the admin right away.
2. On a store that isn't linked yet, Clicktide shows **"Finish connecting Clicktide"**. Click **Connect my Clicktide account**. A new tab opens at goclicktide.com.
3. Log in with the test account below, or create a Clicktide account. Clicktide asks **"Connect the Shopify store _your-store_.myshopify.com to _business_?"**. Click **Connect store**. (This confirmation stops a link from attaching a store to the wrong account.)
4. Back in the Shopify admin, click **I've connected it, refresh**. Clicktide now shows your customers, who is on rhythm and who is drifting.

**Test account:** _(fill in before submitting: email and password of a dedicated Clicktide owner account with no 2FA, per rule 4.5.5)_

### 2. Choose a plan (Shopify billing)
- Clicktide bills through Shopify. Pick **Local, Growth or Scale** on Shopify's plan page; each has a **30-day free trial**.
- On a development store this is a test charge, so nothing is billed, and it unlocks the full app.

### 3. See it working
- **Import:** within a few minutes, Clicktide imports the store's orders and customers. Customers without an email or phone (guest or POS walk-ins) are counted but can't be messaged.
- **Overview:** shows the active customer base, who is drifting and the dollars at risk. Rhythms need at least 2–3 orders per customer.
  - The fastest way to see real behaviour is a store with backdated order history. We test on a store with 60 customers and 331 orders over 10 months: regulars, lapsed customers and returners.
  - We're happy to give you access to that store if it helps.
- **Customers:** each customer's learned rhythm (for example "usually every 21 days") and status (healthy / drifting / at risk / back).
- **Campaigns:** turn on the Win-Back Playbook. Nothing is sent until the merchant activates a campaign. Texts only go to customers who opted in, and only between 9am and 8pm in the business's time zone.

### 4. Open from the Shopify admin
- Apps → Clicktide opens Clicktide's embedded page with the store's current numbers. No reinstall, and no permissions screen again.

### 5. Uninstall and privacy
- Uninstalling stops syncing immediately: the token is wiped and the connection deactivated.
- `shop/redact` (sent 48 hours later) deletes the store's customers and order history from Clicktide.
- `customers/redact` deletes that shopper.
- `customers/data_request` is fulfilled to the merchant by our support team within 30 days.
- Privacy policy: https://goclicktide.com/privacy (see the Shopify section). Support: support@goclicktide.com.

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
