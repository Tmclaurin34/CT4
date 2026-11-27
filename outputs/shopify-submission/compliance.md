# Compliance checks (run 2026-11-27)

## Shopify automated checks
App Store review page: https://partners.shopify.com/4969291/apps/378037403649/distribution/app-store

| Preliminary step | Status |
|---|---|
| Queries supported API versions | ✅ |
| Fixed requirement issues with configuration | ✅ |
| Emergency contact for the account | ⬜ owner adds (Settings) |
| Listing content (English) complete | ⬜ only the Screencast URL is missing |
| Completed request to access protected customer data | ✅ |
| Passed automated check for common errors | ✅ |
| Specialized capabilities | ✅ "Doesn't have specialized capabilities" |
| AI self review + "I've reviewed all the App Store Requirements" | ⬜ owner ticks |

Notes:
- The automated checks ran against the released config, **clicktide-8** (non-embedded).
- `application_url`: https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-app
- Scopes: `read_orders,read_customers,read_all_orders`, with no write scopes.
- The page has no manual re-run button; Shopify re-runs the checks itself.

## Policy URLs (checked live)
| Page | URL | Result |
|---|---|---|
| Privacy policy | https://goclicktide.com/privacy | 200, "Clicktide Privacy Policy" |
| Terms of service | https://goclicktide.com/terms | 200, "Clicktide Terms of Service" |
| Billing policy | https://goclicktide.com/billing-policy | 200, "Clicktide Billing Policy" |

## GDPR compliance webhooks
Configured in `shopify.app.toml` (released as clicktide-8):
- `compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]`
- Endpoint: `https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks`

| Topic | No HMAC | Wrong HMAC | Shopify-signed (CLI `app webhook trigger`) |
|---|---|---|---|
| customers/data_request | 401 | 401 | accepted, processed: `{"matching_records":0,"support_notified":true}` |
| customers/redact | 401 | 401 | accepted, processed: `{"businesses":0,"customers_deleted":0}` |
| shop/redact | 401 | 401 | accepted, processed: `{"businesses":0,"customers_deleted":0,"connections_deleted":0,"store_accounts_deleted":0,...}` |

How we know:
- A webhook is stored in `shopify_webhook_events` only after its HMAC checks out. Then it's processed, and the event is acknowledged with 200. Events 11 to 13 are today's signed test deliveries for the sample shop `shop.myshopify.com`, so nothing real matched.
- Shopify's own deliveries of `customers/redact` and `shop/redact` this morning were also accepted and processed.
- The data_request test sent the normal "data request received" note to the support inbox. That's expected behavior.

## Protected customer data
Checked read-only at https://dev.shopify.com/dashboard/221453123/apps/378037403649/settings/protected_customer_data. Nothing was edited or saved: Save and Discard are disabled.

- **Level 1 (customer data):**
  - Reasons: app functionality, analytics, personalization, marketing or advertising.
- **Level 2 fields:**
  - Name: app functionality, personalization, marketing.
  - Email: app functionality, marketing.
  - Phone: app functionality, marketing.
  - Address: app functionality, marketing.
- **Data protection details: 16 of 16 answered.**
  - "Requirement not met": 0. "Answer changed": 0.
  - Every answer is Yes, except two that are Not applicable: selling data, and automated decisions with legal effect.

The new Shopify sign-in and store-account deletion don't change any answer:
- **Same data.** Same scopes, and the same fields.
- **Not customer data.** The auto-created account holds only the store's own contact email, which is merchant data.
- **Deletion got stricter.** `shop/redact` now also erases the store's Clicktide account and its rows across the related tables. The money ledgers are kept, as before.
- **Access logging unchanged.** Staff access is still logged. The retention purge still runs nightly.
