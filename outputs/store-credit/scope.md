# "$10 store credit" for Digital Gift campaigns: scope

Scoped 2026-11-28. Plan only: nothing is built. Building waits for Shopify's review to finish.

## The idea

The business picks "Store credit · $10" in a campaign. Clicktide fills in the offer, the code and the expiry, and shows how to create that code in the business's own POS. Customers who come back use it. Clicktide then counts who actually used it.

Store credit is the cheapest win-back gift: nothing ships, and the business pays only when the customer returns.

## What exists today (checked)

| Piece | Where | Status |
|---|---|---|
| Digital Gift campaign type | Campaign builder, step 2 (`cModal`) | Live |
| Offer / Code / Expires / Online link fields | `cmRewOffer`, `cmRewCode`, `cmRewExp`, `cmRewLink`, saved to `campaigns.reward_*` | Live |
| Code added to the email (styled box) and the text | campaign-runner `rewardBlocks()` | Live |
| Store's Shopify domain | `ctIsShopDomain` / `shopify_shop_domain` in index.html | Live. Lets us build the online discount link automatically. |
| Knowing which orders used the code | Nothing. platform-sync doesn't store discount codes today. | **Missing** |

Clicktide's POS connections are read-only. That has two consequences:
- **It can't create the code itself.** The business makes it once in its own POS.
- **It can't stop reuse itself.** Limits like "one use per customer" are set in the POS when the code is made.

> **Money rules:** every paid step here follows [the shared spending rules](../business-roi/scope.md): margin-based worth, the up-front rule, the credit minimum spend, free-first, the monthly cap and auto-pause. Where this document gives a different number, those rules win.

## What gets built

### 1. Quick picks in the Digital reward box (index.html)
Four quick picks: **$5 · $10 · $15 · custom**, plus "minimum spend" (none / $25 / $40). Choosing **$10 with a $30 minimum** fills in:
- **Offer:** "$10 off your next visit (on $30 or more)"
- **Code:** suggested as `MISSYOU10`. It's editable and checked to be letters and numbers only, up to 15 characters.
- **Expires:** 30 days out, editable.
- **Online link:** filled in only for Shopify stores, as `https://{store}.myshopify.com/discount/MISSYOU10`. Shopify's own shareable discount link applies the code at checkout. It needs no new permissions.

### 2. "Create this code in your POS" steps
These sit under the code field and match the business's connected POS:
- **Shopify:** Discounts → Create discount → Amount off order → code MISSYOU10, $10, minimum $30, one use per customer, end date.
- **Square:** Items → Discounts → create the discount for the register. Online codes are set up separately in Square's online store.
- **Clover:** the register's Discounts setup. The cashier applies it.
- **Other or no POS:** "Tell your staff the code." The cashier gives $10 off.

Each set of steps includes a link to the POS's own help page. Before the campaign can be turned on, the owner must tick **"I've created this code in my POS."** Without it, customers would arrive with a code that doesn't work.

### 3. Counting redemptions (platform-sync, read-only)
- **Shopify:** orders already include the discount codes used, through the read-orders permission Clicktide already has. Save them per order.
- **Square:** orders list the discounts applied, by name. Save those names.
- **Clover:** orders list discounts by name. Save those names.
- New table `reward_redemptions`, limited to each business's own rows: business, campaign, customer, order, code, amount, date.
- A redemption is matched when an order's code (or discount name) equals the campaign's code. If it was sent to that customer, it counts toward that campaign.
- **Results screen:** "Sent 40 · Used 9 · $412 in return visits · $90 in credit given."
- **Cashier-typed codes** only show up if the POS records the discount by name. If staff type in a manual dollar amount, nothing is recorded. Those visits still count as returns through the existing won-back tracking.

### 4. Gift Intelligence tie-in
Store credit becomes the default "small" gift in [the gift recommendation plan](../gift-intelligence/scope.md):
- Mailed gifts only go to premium customers.
- The cost shown is the credit × the expected redemption rate, not the full $10 for every send.

### 5. Maya + MISSION.md
Teach Maya the store-credit option and the POS setup steps. Check it with live Q&A.

## What it does NOT do (and why)
- **Unique codes per customer:** this needs write access to discounts (Shopify `write_discounts`, Square catalog write). That's a new permission and another Shopify review. Deferred.
- **Real gift cards with a balance:** Square charges a 2.5% load fee and only lets Clicktide add balance through a fragile workaround. Shopify needs `write_gift_cards` and is often limited to Shopify Plus stores. Clover has no API for it. Deferred.
- **Applying the code at the register automatically:** the POS connections are read-only. The cashier enters it, the same as today's reward codes.

## Risks
- **A shared code can be forwarded.** Mitigation: the POS setup steps say to turn on "one use per customer" and a minimum spend.
- **Code made after customers already got it:** prevented by the required "I've created this code" tick.
- **Expired code in old messages:** emails and texts already show the expiry date.

## Build order and size

| # | What | Touches | Size |
|---|---|---|---|
| 1 | Quick picks, Shopify link, required tick | index.html (coordinate with the security session; run `apply_frontend_fixes.py --check`; compare live vs repo before deploy) | Small |
| 2 | POS setup steps | index.html | Small |
| 3 | Redemption capture + results | platform-sync, new migration, index.html results card | Medium |
| 4 | Gift Intelligence tie-in | Part of that build | Small |
| 5 | Maya sync | Maya prompt, MISSION.md | Small |

Build 1, 2 and 5 first: together they're a complete feature. Number 3 adds the proof and can follow.

## Decisions (defaults, change any)
- **Quick picks:** $5 / $10 / $15 + custom. **Default:** $10 on $30 or more, expires in 30 days.
- **Plans:** all plans, Local included, because digital reward codes are already a Local feature.
- **Suggested code:** `MISSYOU10`, editable.
