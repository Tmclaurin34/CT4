# Clicktide: Shopify App Store submission packet

Prepared 2026-11-27. Everything up to, but not including, **Submit for review**. The owner presses Submit.

**Status:** The released config (clicktide-8, non-embedded) passes Shopify's automated checks. All 7 sign-in end-to-end tests pass, including test 6 (TOTP), which the security session ran live. The listing draft is saved with no open issues. The screencast is on YouTube (Unlisted, Clicktide channel): https://www.youtube.com/watch?v=-xK3IZuQp_U, checked as playable while signed out. The emergency contact is added. Left: the requirements checkbox, then Submit.

| File | What's in it |
|---|---|
| [listing-copy.md](listing-copy.md) | Every listing field exactly as saved in the draft, plus pricing and categories |
| [reviewer-instructions.md](reviewer-instructions.md) | The text in the "Testing instructions" field (already pasted) and the test-account decision |
| [screencast.md](screencast.md) | The finished screencast: file, scene order, where to host it |
| [compliance.md](compliance.md) | Automated checks, policy URLs, GDPR webhooks (tested today), protected customer data (16/16) |
| [images/](images/) | Feature image and 3 screenshots (1600×900), already uploaded to the listing |

The screencast file is `outputs/shopify-screencast/clicktide-shopify-review-screencast.mp4`. It's about 100 MB, so it isn't copied here.

---

## What the owner still has to do, in order

1. **Upload the screencast to YouTube as Unlisted.** Shopify's form says YouTube or a direct video file that opens without a sign-in. It does **not** accept Google Drive or Vimeo. Copy the link.
2. **Listing form → App testing information → Screencast URL:** paste the YouTube link, then **Save**. The listing's issue count drops to 0.
   - Form: https://apps.shopify.com/services/partner-app-submissions/1e876d10b4e052fe9897dd45bd859eca/en
3. **Emergency contact:** Partner Dashboard → Settings → add an email and phone number for critical technical issues. The review page links to it with "Fix in settings".
   - Emergency email: support@goclicktide.com, or another inbox you watch.
   - Emergency phone: your own cell. Only Shopify sees this field.
     - The number is deliberately not written in this packet.
     - Don't put it in the listing's public support phone either. Leave that blank: support@goclicktide.com is the public contact.
4. **Self-review:** on the App Store review page, read the App Store Requirements, then tick **"I've reviewed all the App Store Requirements"**. That's an attestation, so it's yours to tick. The "Run AI self review" command is optional.
   - Review page: https://partners.shopify.com/4969291/apps/378037403649/distribution/app-store
5. **Test account:** leave **"My app doesn't require an account to use it"** ticked. It already is. See reviewer-instructions.md for why we don't hand reviewers a login.
6. *(Optional, can skip)*:
   - Plan "top features" for Local / Growth / Scale (suggested text is in listing-copy.md).
   - Integrations.
   - SEO title tag.
7. **Submit for review.** The button enables once the preliminary steps above are green.

Support contact is already filled in: preferred channel email, support@goclicktide.com, confirmed as the support address. It receives mail through Cloudflare Email Routing. The review email and the submission email are both support@goclicktide.com. The listing's support phone stays blank on purpose.

## Changed today, before this packet

- **Billing wording for Shopify stores** (live on goclicktide.com). Shopify-billed stores no longer see "wallet":
  - The campaign builder says "$1.50 each, billed through Shopify".
  - The sidebar shows "Usage & billing" in place of "Wallet", with no Add Funds button.
  - Gift sends follow the same rule as the backend: billed through Shopify only while the paid plan is running. During the trial and on development stores, they're explained instead of refused with a wallet error.
  - Patch: `shopify/site-patches/shopify_billing_copy_patch.py`, commits f942432 and 310046b. The security script's check still passes.
- **Dev store `clicktide-install-test`:**
  - It has 2 paid test orders (#1001, #1002).
  - Clicktide was uninstalled and reinstalled to record the screencast.
  - It is on the Local plan trial again.
