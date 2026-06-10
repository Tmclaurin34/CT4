# Clicktide Wrap-Up

Updated: June 9, 2026

## Current Live/Preview Status

- Live domain: https://goclicktide.com
- Local preview: http://127.0.0.1:8013/clicktide.html
- Latest deploy zip: `clicktide-cloudflare-upload.zip`
- Cloudflare deploy folder: `clicktide-cloudflare-upload/`
- Main working file: `outputs/clicktide.html`
- Cloudflare entry file: `clicktide-cloudflare-upload/index.html`

## Main Product Direction

Clicktide is a gift automation platform for businesses that want to reward loyal customers and win back churn-risk customers.

Core message:

- Send a gift. Start a tide.
- Reward loyal customers and bring churn-risk customers back.
- Connect business platforms, trigger campaigns, send gifts, and track fulfillment.

## Website and App Built

- Landing page with product positioning, ROI calculator, gift samples, pricing, and dashboard entry.
- Dashboard for business users.
- Back office/admin area for owner/admin support.
- Customer, campaign, shipment, wallet, and settings sections.
- Professional legal pages:
  - Terms
  - Privacy Policy
  - Billing / Refund / Cancellation Policy
- Removed draft/legal disclaimer language from public policies.
- Added footer-style legal links and public-facing policy pages.
- Added mobile-friendly layout work.
- Removed public fulfillment-provider branding from customer-facing pages so customers do not see Printify/Resend as the provider.

## Branding and Product Samples

- Added gift sample/product catalog section on the landing page.
- Added customer-visible gift samples before payment so businesses can see possible gift items.
- Added real Printify-hosted product images for sample items.
- Adjusted product image boxes so images blend better with the photo background.
- Added catalog categories such as apparel, drinkware, bags, stationery, and accessories.
- Added small gift ideas such as cards, stickers, notebooks, pens, tumblers, mugs, hats, bags, shirts, and hoodies.

## Upload Quality and Print Validation

Built upload requirements and automatic validation before fulfillment.

Validation now checks:

- PNG, JPG, and SVG support.
- Minimum image resolution.
- Recommended image resolution.
- Effective PPI.
- Sharpness / blur.
- Lighting.
- Compression warning signs.
- Screenshot/social/profile/download filenames.
- Face visibility when supported by the browser.

Print Quality Score:

- 90-100: Excellent
- 80-89: Good
- 70-79: Acceptable
- Under 70: Warning
- Under 60: Reject

Upload rules:

- Minimum photo target: 2000 x 2000 px.
- Recommended: 3000 x 3000 px or better.
- Original phone/camera images preferred.
- Screenshots, social media downloads, profile pictures, and compressed downloads are blocked or warned.

Important next backend step:

- The front-end gate is built.
- For highest safety, the same validation result should be enforced server-side before fulfillment so orders cannot bypass the browser check.

## Supabase

Project ref:

- `hmihfncvahsdlmefyxyg`

Supabase is connected and used for:

- Auth
- Profiles/business data
- Campaigns
- Shipments
- Wallet data
- Edge Functions
- Secrets
- Storage

RLS/security work:

- RLS was tightened for customer/business data.
- Admin/partner support structure was discussed and partially prepared.
- Back office access is intended for owner/admin/partners to help onboard clients and troubleshoot.

## Supabase Edge Functions

Existing/created functions include:

- `create-checkout-session`
- `stripe-webhook`
- `printify-fulfill-gift`
- `sync-printify-catalog`
- `send-customer-email`
- `send-customer-sms`
- `ai-proxy`
- OAuth callback functions for connected platforms

Recent function work:

- Printify catalog sync function was added/deployed.
- Gift catalog sample images were updated.
- Stripe checkout/session work was connected.
- Mindbody credentials were added as secrets.

## Secrets Added/Verified

Important: secret values are not listed in this file.

Verified in Supabase:

- `MINDBODY_API_KEY`
- `MINDBODY_SOURCE_NAME`
- `MINDBODY_SOURCE_PASSWORD`

Other configured secret areas include:

- Stripe
- Printify
- Twilio
- Resend/email
- Shopify/Square/Clover-related integrations

Security note:

- Any Supabase access token pasted during setup should be revoked/rotated after setup is complete.

## Stripe

Stripe is connected for subscription plans.

Plans created:

- Local Plan
- Growth Plan
- Scale Plan

Stripe work completed:

- Stripe publishable/secret keys were configured.
- Stripe product/price IDs were gathered.
- Checkout session Edge Function was created.
- Stripe webhook setup was started.
- Subscription status warning appears in the dashboard until Stripe marks the plan active/trialing.

Next Stripe checks:

- Confirm webhook events are configured.
- Test checkout with a test plan/card before accepting live customers.
- Confirm subscription status updates correctly after checkout.

## Gift Wallet

Business gift wallet concept:

- Each business should have its own gift wallet balance.
- Gift wallet funds are tracked per business, not globally mixed in the app UI.
- Safest money-storage approach: use Stripe/payment processor as the real source of funds and keep Clicktide database as a ledger, not a bank.

Recommended wallet behavior:

- Business adds funds through Stripe.
- Clicktide records wallet ledger entries in Supabase.
- Campaign gift costs deduct from that business wallet.
- Admin/back office can refund unused wallet funds through the processor and record the ledger change.
- Avoid storing raw payment details in Clicktide.

Next wallet step:

- Enforce all wallet charges/refunds server-side only.
- Add admin refund controls that call Stripe rather than manually editing balances.

## Fulfillment

Fulfillment providers discussed/connected:

- Printify
- Printful as possible additional fulfillment option

Fulfillment direction:

- Customers should not see fulfillment provider branding.
- Businesses choose gift items from Clicktide.
- Clicktide routes the order to fulfillment behind the scenes.
- Test gift functionality should live in back office/admin tools, not in normal customer flow.

Next fulfillment checks:

- Confirm real Printify shop products are created.
- Confirm Printify API can create an order.
- Confirm order appears in Printify.
- Confirm Clicktide records shipment status.

## Email and SMS

Email:

- Resend was discussed as the transactional email provider.
- Email send function exists.

SMS:

- Twilio was added to the plan.
- `send-customer-sms` Edge Function exists.
- SMS support should be used for customer messages, campaign notifications, reminders, or alerts where consent allows it.

Next communication checks:

- Confirm Resend domain/API key is active.
- Confirm Twilio phone number and credentials are active.
- Send one test email.
- Send one test SMS.
- Confirm opt-in/consent language before sending marketing texts.

## Mindbody

Mindbody live API access was approved.

Supabase secrets verified:

- `MINDBODY_API_KEY`
- `MINDBODY_SOURCE_NAME`
- `MINDBODY_SOURCE_PASSWORD`

Mindbody flow:

- Clicktide has platform credentials.
- Each Mindbody business still needs its own `SiteID`.
- Business enters SiteID during onboarding.
- Clicktide retrieves an activation code.
- Business owner approves/links that activation code in Mindbody.
- After approval, Clicktide can access that business's Mindbody data.

Next Mindbody build:

- Add Mindbody onboarding screen in Clicktide.
- Let businesses enter SiteID.
- Call Mindbody activation-code endpoint from Supabase.
- Show activation code and instructions.
- Save connected SiteID/business mapping after activation.

## Domain and Hosting

Domain:

- `goclicktide.com`

Registrar:

- Namecheap

DNS/Hosting:

- Cloudflare is protecting the domain.
- Cloudflare Pages is hosting the static Clicktide site.
- Nameservers were changed from Namecheap to Cloudflare.
- Root domain became active.
- `www.goclicktide.com` was still verifying for a period.

Cloudflare Pages project:

- `clicktide-app`

Deploy file:

- `clicktide-cloudflare-upload.zip`

After changes:

- Upload the latest zip to Cloudflare Pages.
- Deploy to production.
- Check `https://goclicktide.com`.
- Check `https://www.goclicktide.com` once verification completes.

## Latest File Locations

Main files:

- `outputs/clicktide.html`
- `outputs/index.html`
- `outputs/backoffice.html`
- `outputs/terms.html`
- `outputs/privacy.html`
- `outputs/billing-policy.html`

Deploy files:

- `clicktide-cloudflare-upload/index.html`
- `clicktide-cloudflare-upload/clicktide.html`
- `clicktide-cloudflare-upload/backoffice.html`
- `clicktide-cloudflare-upload/terms.html`
- `clicktide-cloudflare-upload/privacy.html`
- `clicktide-cloudflare-upload/billing-policy.html`
- `clicktide-cloudflare-upload.zip`

## Known Issues / Next Fixes

High priority before live customers:

- Finish Mindbody onboarding.
- Enforce upload validation server-side before fulfillment.
- Confirm Stripe checkout and webhook lifecycle.
- Confirm wallet ledger and refund behavior.
- Confirm Printify test order works.
- Confirm email and SMS tests work.
- Confirm admin/back office permissions.
- Remove any leftover development/test labels from the user-facing dashboard.
- Rebuild/upload the Cloudflare zip after final changes.

Nice-to-have soon:

- Add better product mockup preview tools.
- Add logo/text preview on sample products.
- Add brand kit file requirements per item.
- Add help tooltips and onboarding prompts.
- Add business contact vs personal contact polishing.

## Suggested Next Order of Work

1. Build Mindbody onboarding flow.
2. Finish backend fulfillment safety gate.
3. Test Stripe checkout and webhook.
4. Test wallet add funds and refund ledger.
5. Test one Printify fulfillment order.
6. Test one Resend email.
7. Test one Twilio SMS.
8. Upload final Cloudflare zip.
9. Run final live-site walkthrough.

