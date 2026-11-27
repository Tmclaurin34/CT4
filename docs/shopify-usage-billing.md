# Shopify usage billing: operations

For Shopify-billed businesses, postcards, gifts and texts past the plan's limit are reported to
Shopify's App Events API as usage. This covers the database side (migration
`20261128170000_shopify_usage_billing.sql`) and the reporter (`shopify-webhooks`, job `usage`,
every 10 minutes).

## What gets billed
- **Prepaid first.** A prepaid wallet balance that covers the whole charge pays it.
- **Shopify usage.** If the balance can't cover it, the whole charge becomes Shopify usage when
  all of these hold:
  - the business is Shopify-billed and its plan is live and out of trial;
  - it has exactly one active Shopify connection, and that is the billed shop;
  - the store isn't a development store and the charge isn't a test charge;
  - the limits were synced within the last 3 hours;
  - the charge is inside the current cycle and under the cycle limit.
- **Refused otherwise.** The charge returns `insufficient_funds` with `shopify_usage_refused: true`.
- **Cycle limits** (Clicktide's own; App Pricing meters have no Shopify cap): Local $150,
  Growth $400, Scale $900. During a free trial the limit is $0, because Shopify's docs don't say
  whether trial usage is billed. To raise it, edit `clicktide_shopify_usage_plan_limit` and confirm
  in the Dev Dashboard logs that trial events are billed.
- **No new Shopify usage in the cycle's last hour.** An event after the cycle ends is rejected
  (`PERIOD_CLOSED`). Postcards and gifts need the exact unit price ($1.50 / $0.05) to bill as usage.
- **Refunds** follow their own debit (key `<debit key>:refund`). A refund of a Shopify charge is
  sent to Shopify as a negative event. If neither the charge nor its refund has been sent yet,
  the pair is cancelled and never sent.

## Alerts (to support@)
- **Dead-man (ops-alerts, hourly):** no successful usage run in 45 minutes while any business is
  Shopify-billed.
- **Stripe switch stuck:** a business that switched to Shopify billing whose Stripe subscription isn't
  confirmed stopped after 5 tries. Sent at most daily. Fix it in Stripe, then set `done_at`.
- **Overdue:** usage not accepted by Shopify an hour after it happened. Sent at most every 6 hours.
- **Mismatch:** for legacy Billing API subscriptions only, Shopify's `balanceUsed` differs from what
  we reported this cycle.

## Manual monthly check (App Pricing exposes no billed total to the Admin API)
A `202` from App Events means "received", not "billed". Once a month, for each Shopify-billed store:
1. Dev Dashboard → Clicktide → Logs, filtered to **App billing event**. Look for rejections
   (`NO_SUBSCRIPTION`, `NO_MATCHING_METER`, `PERIOD_CLOSED`).
2. Partner Dashboard → Payouts / app charges. Compare the usage charged with:
   ```sql
   select l.shop_domain, clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start, true) as reported
     from shopify_usage_limits l where not l.test_or_dev;
   ```
3. Investigate any difference, and any rows still unreported:
   ```sql
   select id, user_id, transaction_type, amount, shopify_usage_attempts, shopify_usage_error
     from wallet where shopify_usage and shopify_usage_reported_at is null and shopify_usage_cancelled_at is null;
   ```

## Turning it off
`select cron.unschedule('clicktide-shopify-usage');` stops reporting. The rows stay queued and are
sent when it's back. To stop new Shopify usage, unset `SHOPIFY_BILLING_ENABLED`. The usage limits
then go stale within 3 hours, and every Shopify charge is refused.
