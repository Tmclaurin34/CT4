# Reviewer instructions

## Test account decision

Leave **"My app doesn't require an account to use it"** ticked. It already is in the draft. Do **not** enter a login. There are three reasons:

- **Accounts are created automatically.** Installing Clicktide creates the store's own Clicktide account. Opening the app from the Shopify admin signs the reviewer in with a one-time code. No sign-up and no password are involved, so there's nothing to log in to.
- **Shopify's form rules out the alternatives.** It says not to provide accounts that need SSO or an extra step. It also says not to give credentials for Shopify test stores.
- **The candidate account is the owner's real business account.** The pre-made website login considered for this is business 675f5e6d, which is the owner's own business account. Handing its password to reviewers would expose real account data, and the reviewer doesn't need it.

If Shopify later asks for a website login anyway, the owner enters it **only** in the listing form's private "Test account" fields:
- Use business 675f5e6d, which must stay free of two-step login.
- The credentials are entered by the owner and never written in this packet.

## Store-provisioned accounts (for us)

- An account Clicktide creates for a store has an internal address (`<store>@shopify-users.goclicktide.com`) and **no password**.
- It can only be opened from that store's Shopify admin (Apps → Clicktide). Password-reset requests for those addresses send nothing and give the generic reply.
- On `shop/redact`, the store's data and that account are erased, unless the app was reinstalled.

## Text in the "Testing instructions" field

This is already pasted in the draft (2,648 / 2,800 characters) and matches what's below. The scopes table at the end is extra reference, not in the field.

### For the reviewer

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
