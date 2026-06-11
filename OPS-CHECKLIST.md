# 🚀 Clicktide ops checklist (fresh environment / disaster recovery)

## Database
- [ ] Run `supabase/migrations/20260611000000_full_schema_snapshot.sql` (fresh installs)
- [ ] Run `supabase/migrations/20260611000001_upgrade_and_lockdown.sql` (always — columns, backfill, RPC revokes)
- [ ] Create Vault secret `CAMPAIGN_RUNNER_KEY` (Dashboard → Vault) — campaign engine auth depends on it
- [ ] Enable pg_cron jobs: campaign-runner hourly (`0 * * * *`), platform-sync daily (`0 6 * * *`),
      weekly-drift-report Mon (`0 12 * * 1`), ai-suggest-campaigns Mon (`0 13 * * 1`) — commands use
      `net.http_post` with the Vault key header (see cron.job on the live project for exact SQL)

## Edge function secrets (Project Settings → Edge Functions)
- [ ] `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (domain verified in Resend; open/click tracking on)
- [ ] `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` (A2P campaign approved)
- [ ] `LOB_API_KEY` (live key once payment method added in Lob)
- [ ] `PRINTIFY_API_TOKEN` + `PRINTIFY_SHOP_ID` + `PRINTIFY_WEBHOOK_SECRET`
- [ ] `STRIPE_SECRET_KEY` + plan price ids (`LOCAL_PRICE_ID` / `GROWTH_PRICE_ID` / `SCALE_PRICE_ID`)
- [ ] `ANTHROPIC_API_KEY` (AI suggestions, support chat)

## Webhooks (point at the new project URL)
- [ ] Stripe → `/functions/v1/stripe-webhook` (checkout + subscription events)
- [ ] Resend → `/functions/v1/resend-webhook` (`RESEND_WEBHOOK_SECRET` set, Svix-verified)
- [ ] Printify → `/functions/v1/printify-webhook` (order + shipment events, HMAC secret)
- [ ] Twilio number "A message comes in" → `/functions/v1/survey-response`

## Frontend
- [ ] Deploy via `work/cf_deploy.py` (`CF_TOKEN=cfut_… python3 cf_deploy.py`) — NEVER without the
      inline-script parse check passing
- [ ] Verify: `/`, `/clicktide`, `/gift-address`, `/privacy`, `/win-back-lost-customers` return 200

## End-to-end smoke test (manual, ~20 min — run before any launch)
- [ ] Sign up fresh → confirm email → Square-style welcome arrives
- [ ] Stripe checkout shows 30-day trial; status lands `trialing`
- [ ] Connect POS (or CSV import) → Drift Reveal renders with real counts
- [ ] Install Win-Back Playbook → 3 campaigns appear → engine dry-run (`?dry_run=1`) matches
- [ ] Address request: customer with no address gets the 🎁 email; form saves; next run mails postcard
- [ ] Wallet top-up via Stripe; gift fulfillment with the $1.58 sticker item; tracking email on ship

## Monitoring (next build)
- [ ] Daily ops digest: failed campaign_sends / sms_messages / shipments → email support@
