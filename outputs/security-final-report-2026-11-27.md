# Clicktide security hardening — final report (2026-11-27)

Scope: the 79 confirmed findings from the 2026-11-26 review (5 critical, 25 high, 39 medium) plus the follow-ups you approved ("fix it all", "do it all", "finish everything"). Everything below was deployed to production and checked against the live system unless it says otherwise. This does **not** mean Clicktide is fully secure. It means the known findings were addressed and the fixes were tested.

---

## 1. What I inspected
- Every edge function's live code, downloaded from Supabase before each change, because other sessions deploy to this project too.
- Database policies, grants, triggers, RPCs, cron jobs and storage policies. I also ran read-only "pretend to be user X" probes against production. Postgres refuses writes in that mode.
- The live website pages (goclicktide.com) plus every other public copy of the app: Cloudflare preview aliases, old Cloudflare deployments, Netlify, GitHub Pages and Vercel.
- The Stripe webhook configuration, the Supabase Auth settings and the Supabase access tokens.

## 2. What changed

**Critical fixes**
- **AI helper (`ai-proxy`)**: it was an open relay to Anthropic billed to Clicktide's key. It now accepts only Clicktide's own websites and only short plain-text requests, with the model and answer length fixed. There are two tiers. Signed-in owners get per-account limits. Anonymous visitors share a small capped pool and use a fixed system prompt. Every limiter fails closed.
- **Check-in (`checkin`)**: closed the database filter-injection hole. Added rate limits and a Turnstile bot check. Names are cleaned and never echoed back.

**Tenant isolation and money**
- Billing columns (plan, Stripe IDs, wallet, SMS ledgers) can only be changed by the server. Wallet changes go through one locked RPC (`clicktide_wallet_apply`).
- Staff accounts need two-step login (TOTP, aal2) to use any staff power. The one active staff login is `clicktidebusiness+staff@gmail.com`, and it is enrolled. The test business 675f5e6d is now a plain owner.
- POS connections (Square, Clover, Stripe, Shopify, Mindbody) use server-made one-time OAuth states. The legacy state path is off.
- The Stripe webhook listens to all 13 event types the handler supports.

**Messaging compliance**
- Check-in texting now needs a "Reply YES" confirmation (double opt-in). A YES only counts if a request is pending and less than 7 days old, and the evidence is stored.
- Quiet hours are checked in the recipient's own time zone. The system uses the recipient's state, then their area code, and also requires the business's own window to be open. 377 area codes are mapped.
- Every email has a working per-business unsubscribe link.

**Bot protection (Turnstile)**
- The Turnstile widget is live on login, sign-up, resend-confirmation, the back office, the free POS audit and check-in.
- The check-in, password-reset and launch-inquiry functions refuse requests without a valid token (HTTP 400).
- Supabase Auth CAPTCHA is ON (Turnstile, saved 2026-11-27). Supabase itself now refuses login, sign-up and resend requests without a valid token (400 `captcha_failed`, checked with curl). The owner logged in successfully from a normal browser afterwards.

**Data hygiene**
- A nightly retention purge runs at 09:25 UTC, with dry-run as the default. Deleted customers get their records redacted. The rate-limit table is cleaned up daily.
- Logo storage has size and type limits, and the legacy path is closed.

**Exposure cleanup**
- Deleted 262 pre-fix Cloudflare deployments. Kept 14 for rollback; their IDs are saved in `clicktide-backups/`.
- Redeployed stale preview aliases.
- You deleted all 4 Netlify sites, and GitHub Pages is off. The Vercel copy sits behind a login wall.

**Keys and secrets**
- Rotated the Supabase access token twice. It is now project-scoped (`clicktide-cli-2026-11b`); old and exposed tokens were deleted and confirmed dead (401).
- Rotated the campaign-runner key in Vault and removed 4 unused secrets.
- SSL is enforced for direct database connections.

**Front end**
- Third-party scripts are pinned with SRI.
- Owners can turn on two-step login from Settings.
- The back office includes staff TOTP enrollment.

## 3. Why
Each change maps to one or more of the 79 findings. The highest-risk ones were:
- a public relay that could run up the Anthropic bill;
- the check-in injection;
- staff accounts able to edit billing columns without two-step login. I proved this live with a test write, then reverted it.
- old copies of the app still serving pre-fix code against the production database.

## 4. Files and database objects
- **Migrations:**
  - `20261127210010`–`024`: security batch
  - `030`: OAuth cutover
  - `031`–`032`: logos
  - `033`: grants and indexes
  - `034`: `clicktide_is_staff_member()`
  - `035`: staff MFA required
  - `20261128150000/150100`: retention purge and cron
  - `20261128160000`: SMS double opt-in
- **Key objects:** `rate_limits` and `clicktide_rate_limit_hit`, `clicktide_wallet_apply`, `oauth_pending`, `email_suppressions`, `engine_runs`, `job_leases`, `sms_consent_requests`, `clicktide_sms_optin_request/confirm`, `clicktide_security_retention_purge`, `clicktide_security_flags.staff_require_mfa`.
- **Edge functions:** all 39 redeployed through race-checked deploys (the live code had to match what was shipped). The latest are checkin, password-reset and launch-inquiry (Turnstile), plus campaign-runner, survey-response and send-customer-sms (SMS package).
- **Site** (`clicktide-cloudflare-live/`): index.html, backoffice.html, free-pos-audit.html, checkin.html.
- **GitHub (Tmclaurin34/CT4):** PRs [#7](https://github.com/Tmclaurin34/CT4/pull/7), [#8](https://github.com/Tmclaurin34/CT4/pull/8), [#9](https://github.com/Tmclaurin34/CT4/pull/9) and [#10](https://github.com/Tmclaurin34/CT4/pull/10), all merged.
- **Backups:** `clicktide-backups/`, including the full logical backup taken before the batch and copies of the site before each change.

## 5. Security improvements (plain English)
- Strangers can't use Clicktide's AI account as a free chatbot or run up its bill.
- One business can't see or change another business's data, billing or wallet. This was tested by simulating owners against production.
- Staff powers need a phone code, not just a password.
- Bots can't spam check-in, password reset, the contact form, login, sign-up or confirmation resends.
- Customers only get texts after confirming, and only at reasonable hours where they live.
- There are no more old public copies of the app pointing at the real database.

## 6. Tests run
- **Turnstile test suite** (exit 0): checkin 61/0, password-reset 59/0, launch-inquiry 57/0, SMS rigs 43/0 and 44/0. Deliberately broken "mutant" versions fail these tests, which shows they catch real breakage.
- **Live curl checks:** requests with a missing or bogus Turnstile token get 400 `turnstile_failed`. Origin checks and rate limits answer correctly.
- **Signed-in browser tests:**
  - AI signed-in tier works;
  - logo upload goes to the owner's own folder;
  - Square OAuth start works;
  - Stripe checkout works;
  - all 9 dashboard sections load with 0 failed requests.
- **Tenant probes:** a non-staff owner sees 0 other businesses, and billing writes are ignored. A staff account without two-step login has no powers; with it, the back office works.
- **Engine dry runs:** campaign-runner's quiet-hours self-check is OK, and ops-alerts and owner-alerts are healthy.
- **Production pages:** they serve the token-sending code (checked 2026-11-27 20:05 UTC).
- **Auth CAPTCHA:** login, sign-up and resend without a token, or with a bogus one, return 400 `captcha_failed`. A real login from the owner's own browser succeeded.

## 7. Pass/fail
- All tests above **passed**.
- The live re-check of the 79 findings, taken mid-rollout, was 38 fixed, 39 partial and 2 open. The later rounds closed most of the partial and open items: Turnstile, staff MFA, double opt-in, recipient-local quiet hours, retention, AI tiers and SRI.
- The items in section 8 are still open.

## 8. Remaining risks (honest list)
1. **No point-in-time recovery.** Supabase Pro takes daily backups. PITR is a paid add-on.
2. **Owner two-step login is optional.** Owners can turn it on; it isn't forced. It is also enforced only by the website, not by the database. A separate task is working on a database rule and will ask before changing production.
3. **Retention purge not yet run.** Its first scheduled run is 2026-11-28 09:25 UTC; check the result after that.
4. **Shopify usage billing is unproven.** The dev-store test charge passed, but a real usage event to Shopify hasn't happened yet. That work is owned by the Shopify session.
5. **This is not a guarantee.** New code, new integrations and leaked passwords can still create risk. A periodic re-review is recommended.

## 9. Action required from you
1. ~~Save Auth CAPTCHA~~: done and verified 2026-11-27.
2. ~~Send the real business mailing address~~: done 2026-11-27. CLICKTIDE_POSTAL_ADDRESS = "P.O. Box 304, Glen Cove, NY 11542", confirmed as seen by the edge functions.
3. ~~Set `PRINTIFY_WEBHOOK_SECRET`~~: done 2026-11-27. A random secret is stored in Supabase, and 4 Printify order webhooks are registered (updated, sent-to-production, shipment created, shipment delivered). Unsigned or wrongly signed events get 400; correctly signed ones get 200.
4. Optional: turn on two-step login for your own owner account (Settings → 2-step login). Leave the test business 675f5e6d without it, because it's the Shopify reviewer account.
