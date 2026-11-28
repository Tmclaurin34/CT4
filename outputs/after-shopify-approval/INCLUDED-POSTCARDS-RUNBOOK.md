# Included postcards: switch on AFTER Shopify approves the app

Owner decision, 2026-11-28: include postcards in the subscription price, but only after the
Shopify review passes, so the site, the Shopify listing and the billing never disagree while a
reviewer is checking them.

Allowance per plan, per month (owner to confirm against Lob's per-card cost before switching on):
**Local 10 · Growth 30 · Scale 75.** Change the numbers in step 1 if the owner picks different ones.

## What's ready

| Piece | File | State |
|---|---|---|
| Database: allowance, claim and release functions | `supabase/migrations/20261128040000_included_postcards.sql` | written, **NOT applied** |
| Sending engine: uses a free card first, charges $1.50 only after the allowance is used | `outputs/after-shopify-approval/campaign-runner.STAGED-included-postcards.ts` | staged on top of live **fff615c8d6ee**, **NOT deployed** |
| Site wording | `site-patches/postcard_wording_patch.py` made it "postcards $1.50 each" | revert to "N postcards/mo included" |

## Switch-on steps (all in one sitting)

1. **Check the numbers.** Confirm the allowance (10 / 30 / 75 or the owner's new choice). Edit lines ~42-44 of the migration if they change.
2. **Re-check the live engine.** Download `campaign-runner`. If its sha is no longer `fff615c8d6ee`, someone deployed since:
   - re-merge the free-postcard hunks (claimFreePostcard / releaseFreePostcard, the payment block, the `postcards_included` counter and the `isFree` release branch) onto the new live version;
   - do not deploy the stale staged file.
3. **Apply the migration.** Test it in a rolled-back transaction:
   - claim inside the allowance → free;
   - the same key again → duplicate;
   - over the allowance → not free;
   - release → slot returned.
4. **Dry-run the staged engine** as a canary function (`?dry_run=1`). It must match the live dry run except for the 2 new counters. Then deploy as `campaign-runner`, download it again, and confirm the sha.
5. **Shopify-billed stores.** Confirm that a free card creates no wallet debit and no Shopify usage charge, so included cards are never billed through Shopify. Update the plan descriptions in the Shopify Partner Dashboard to the same allowance.
6. **Site wording.** Change "Email included · postcards $1.50 each" back to "Email + N postcards/mo included" (plus the matching FAQ lines) in:
   - live `index.html` and `free-pos-audit.html` (coordinate with the session that owns them);
   - the redesign copies in `outputs/droplist-site/` and `outputs/website-redesign/new-home.html`.
   
   Run `apply_frontend_fixes.py --check` (must be 0) before deploying.
7. **Maya and help.** Update Maya's plan answers (support-chat PLANS text) and help.html to say postcards are included up to N a month, then $1.50 each.
8. **Verify live.** Mail one real postcard for a test business:
   - wallet unchanged, and `postcards_included` = 1 in the run summary;
   - after the allowance is used up, the next card charges $1.50.
