# Clicktide Security & Data Protection Policy

Owner: Six Seasons Partners LLC (Clicktide) · Adopted: 2026-11-27 · Review: every 6 months, and after any incident.
Contact: support@goclicktide.com

This is the written policy behind Clicktide's answers to Shopify's protected-customer-data questions. Each rule says what is in place and where it lives.

---

## 1. Data we hold and why (data minimization)

| Data | Why | Where it comes from |
|---|---|---|
| Shopper name, email, phone | Send the win-back messages the merchant turns on | POS / Shopify orders, CSV, check-in page |
| Shopper mailing address | Mail postcards and gifts | Orders, or the shopper's own address form |
| Orders: date, total, items | Learn each shopper's visit rhythm, measure returns | POS / Shopify (read-only) |
| Consent and opt-out flags | Respect SMS and email choices | Check-in, STOP replies, unsubscribe links |

Free-audit accounts get aggregated totals only: no shopper names, emails or phones are imported (`platform-sync` audit mode). Clicktide never sells shopper data, never shares one merchant's data with another, and uses it only to provide Clicktide to that merchant.

## 2. Retention and deletion

Built in the database (migration `20261127160000_data_retention.sql`, function `clicktide_retention_purge`, run nightly):

- Data is kept while the business has an active, trialing or past-due plan.
- 90 days after a plan ends (`clicktide.data_closed_at`, set automatically), the business's shopper data is deleted: customers, visits, rhythm, status events, transaction ledger, sends, SMS history, the personal fields on gift shipments, and the POS/Shopify tokens. Billing, invoices and wallet records are kept for accounting.
- Rolling limits for everyone: SMS history 2 years, transaction de-dup ledger 400 days, funnel analytics 13 months, expired OAuth states 1 day.
- Shopify `customers/redact` and `shop/redact` webhooks delete the shopper's or store's data; `customers/data_request` is fulfilled to the merchant. All within 30 days.
- Deletion on request: email support; handled within 30 days.

## 3. Encryption

- In transit: every connection is HTTPS/TLS (Cloudflare Pages for the site, Supabase for the API and database; Supabase enforces SSL on database connections).
- At rest: the Supabase Postgres database and storage are encrypted at rest (AES-256).
- POS and Shopify access tokens are readable only by server code (service role). Browser logins cannot read them (migration `20261127170000_hide_platform_tokens.sql`).
- Backups: Supabase Pro (since 2026-11-27) takes daily encrypted backups of the database, kept 7 days.

## 4. Test vs production data

Production is the Supabase project `hmihfncvahsdlmefyxyg`. Demo mode (`?demo=1`) runs entirely on in-memory sample data, and tests run inside transactions that are rolled back. Shopify review testing uses a development store with test charges only. Real shopper data is never copied into test or demo environments.

## 5. Access control

- **Tenant isolation:** Row-level security on every business table: a business can read only rows where `user_id = auth.uid()`.
- **Staff access:** Only active `clicktide_staff` members (currently 1 admin) can see another business's data, through `clicktide_can_access_client`. Staff access is granted only to people who need it for support and removed when they no longer need it.
- **Access log:** Every back-office view of a business's data calls `clicktide_log_staff_access`, and every staff insert, update or delete on another business's data is logged by trigger. Logs go to `clicktide_admin_audit_log` and store column names, never values. The log is append-only: no browser role can write, edit or delete it (migration `20261127150000_staff_access_log.sql`).
- **Passwords:** Account passwords must be at least 8 characters, and passwords found in known data breaches are rejected (Supabase Auth leaked-password check, on since 2026-11-27).
- **Two-factor authentication:** Staff must turn on two-factor sign-in for the Clicktide admin, Supabase, Shopify Partner, GitHub, Cloudflare and Stripe accounts. Supabase Auth has TOTP 2FA enabled.
- **Secrets:** API keys live only in Supabase Edge Function secrets and the owner's local keychain or files, never in the site code.

## 6. Data loss prevention

- Shopper data never leaves Clicktide except to the processors needed to deliver what the merchant turned on: Twilio (texts), Resend (email), Lob/Printify (mail and gifts), Stripe (billing).
- No shopper data in logs: webhook payloads are wiped after processing, and the staff log stores no values.
- Exports go only to the merchant who owns the data, or to the merchant for a Shopify data request.
- Changes to production go through review, tests, and a check for differences with the live site before deploying.
- Keys are rotated after any suspected exposure (see 7) and when a staff member leaves.
- Daily encrypted backups (Supabase Pro) allow restoring the database after accidental loss.

## 7. Security incident response

1. **Report:** Anyone who suspects unauthorized access or data exposure emails support@goclicktide.com at once. The owner records the time, what was seen, and which systems are involved.
2. **Contain, within 1 hour:** Rotate affected keys (Supabase service key, Shopify client secret, provider tokens). Disable affected accounts or connections, and pause the campaign runner if messages are involved.
3. **Assess, within 24 hours:** Use the database, edge-function and provider logs, plus `clicktide_admin_audit_log`, to work out which data, merchants and shoppers were affected.
4. **Notify:** Affected merchants within 72 hours. Shopify, through the Partner Dashboard, when Shopify data is involved. Anyone else breach-notification laws require (for example, New York's SHIELD Act).
5. **Recover and review:** Fix the cause, restore data if needed, and write a short review within 7 days that covers what happened, impact, and what changed.

Severity: **High** means shopper contact data was exposed. **Medium** means merchant business data was exposed. **Low** means no personal data was involved.
