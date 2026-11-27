# Clicktide: testing instructions for Shopify App Review

Paste the "For the reviewer" section into the submission's testing-instructions field. The checklist at the end is for us, before submitting.

---

## For the reviewer

**What Clicktide does:** Clicktide reads a store's orders, read-only. It learns how often each customer normally reorders, and it shows which customers have gone quiet compared with their own rhythm. The merchant can then turn on win-back messages: email, opted-in SMS, a mailed postcard or a small gift. Clicktide counts recovered revenue only when a customer actually orders again.

**Clicktide runs on its own site (goclicktide.com), not embedded in the Shopify admin.** Installing from Shopify signs the merchant in or up at goclicktide.com, then connects the store.

### 1. Install
1. Install Clicktide from the listing on your development store.
2. Approve the access request: read orders and read customers, with read-only access to full order history.
3. You land on goclicktide.com. **Create a Clicktide account** (any email you can receive mail at). If you already have one, log in.
4. Clicktide asks **"Connect this Shopify store? Connect the Shopify store _your-store_.myshopify.com to _your business_?"** Click **Connect store**. This confirmation stops a link from attaching a store to the wrong account.

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
- Apps → Clicktide opens the Clicktide dashboard directly. No reinstall, and no OAuth screen again.

### 5. Uninstall and privacy
- Uninstalling stops syncing immediately: the token is wiped and the connection deactivated.
- `shop/redact` (sent 48 hours later) deletes the store's customers and order history from Clicktide.
- `customers/redact` deletes that shopper.
- `customers/data_request` is fulfilled to the merchant by our support team within 30 days.
- Privacy policy: https://goclicktide.com/privacy.html (see the Shopify section). Support: support@goclicktide.com.

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
