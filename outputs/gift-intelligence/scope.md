# Maya Gift Intelligence: scope

Scoped 2026-11-27. Plan only: nothing is built yet. Building starts after Shopify's review is done.

## What it does

Each week Clicktide picks out the drifting customers who are worth a gift. For each one it suggests a gift and a price limit, and explains why. The owner approves or skips each one. Nothing is ever bought or shipped without the owner's click. Afterwards, Clicktide checks whether those customers came back, compared with similar customers who got no gift.

## What already exists (checked today)

| Piece | Where | What it gives us |
|---|---|---|
| Each customer's own rhythm | `customer_rhythm` table: visits seen, usual interval, how overdue (`overdue_ratio`), status, confidence | Who is drifting, and whether the pattern can be trusted |
| Visit history | `customer_visits` table: date and amount of each visit | Spend per visit, how long they've been a customer, return after a gift |
| Lifetime totals | `customers` table: `total_spent`, `visits`, address, opt-outs | Value, plus whether a gift can be mailed at all |
| Gift catalog | `gift_catalog`: 4 active items, $6.99 to $27.99 | What can be recommended, at real cost |
| Sending a gift | `sendPhysicalGift` in index.html, plus the `shipments` table and the wallet or Shopify charge | The approve button reuses this. No new money path. |
| Asking for an address | `gift-address` function, `address_request_token` | Customers with no address can still be recommended |
| A price rule | `ai-suggest-campaigns` v14: a gift costs at most half of one high-value visit, enforced on the server | The same rule, applied per customer |
| Approval pattern | The `ai_suggestions` table (status `suggested`) and its cards | Same idea, one row per customer instead of per campaign |

**Gap:** Clicktide stores order totals, not what was in each order. So it can't say "they bought hair treatments". Recommendations can use the business type and the customer's spending, but not which products they bought. Adding line items is a separate, larger job.

> **Money rules:** every paid step here follows [the shared spending rules](../business-roi/scope.md): margin-based worth, the up-front rule, the credit minimum spend, free-first, the monthly cap and auto-pause. Where this document gives a different number, those rules win.

## How it decides (rules first, AI second)

Plain rules decide who qualifies and the most a gift can cost. The AI only writes the reason and the message, and picks from the gifts the rules allow. The server re-checks the AI's pick, the same way the campaign suggestions do today. So the AI can never raise a cost or add a customer.

**1. Who qualifies.** A customer qualifies only if all of these hold:
- At least 3 visits, and a customer for at least 60 days. This excludes one-time buyers.
- Status is drifting or at risk, and the rhythm's confidence isn't low.
- No gift sent in the last 120 days, and no gift recommendation already waiting.
- Can be reached: a mailing address on file, or an email or phone to ask for one. Not unsubscribed from everything.
- Not refunded or complaining recently (rating of 1-2).

**2. Tier:**
- **No gift:** a message is enough. Gifting would cost more than about 20% of a typical return visit, or the customer's value is below the business's average.
- **Small:** a growing relationship, about $7 to $12.
- **Premium:** the top 20% of the business's customers by spend, with a long, steady rhythm. Up to the price limit.

**3. Price limit per customer:**
- At most half of that customer's own average visit, and never more than the premium limit the owner sets.
- If no catalog item fits under the limit, there is no gift recommendation.

**4. Priority:** the order is value at risk, meaning average visit × how overdue they are, adjusted for confidence. Recommendations fill the monthly gift budget in that order, then stop.

## Owner experience

**Gifts page:** a new **Recommended for you** section.
- One card per customer, showing:
  - the customer's name
  - 3 short reasons, for example "14 visits over 19 months · usually every 6 weeks · now 4 weeks late"
  - the suggested gift and its cost, with the message (editable)
- Buttons: **Send gift** · **Send a message instead** · **Skip**.

**Budget line:** "This month's gift budget: $300 · $140 recommended · $0 sent". The owner sets the budget in Settings. It's off until they do.

**Send gift** goes through the existing send path, with the same rules:
- Shopify trial and development stores can't send.
- Wallet stores need enough balance.
- With no address on file, the customer is asked for one first.

**Skip** asks for an optional reason: "not this customer", "too expensive" or "already in touch". Maya learns from skips as well as sends.

## Did it work? (measurement)

- **Holdout:** 1 in 5 qualifying customers is deliberately not recommended, and is marked "held back to measure". The owner can turn this off.
- **Result:**
  - Return rate within 45 days, gifted vs. held back.
  - Revenue from those visits, minus gift cost.
- **Where it shows:**
  - A "Gifts that worked" box on the Gifts page.
  - The Overview's won-back numbers.
  - The results Maya already reads when suggesting campaigns.
- **Honest limits:** with few gifts the comparison means little. Below about 30 gifts per group, the box says "too early to tell" instead of showing a percentage. Today the database has 2 gift shipments and 43 customers with 3+ visits, so most stores will see "too early" for a while.

## Build order

| Phase | What | Touches | Size |
|---|---|---|---|
| 1 | Rules: who qualifies, tier, limit, priority, as one database function (`clicktide_gift_candidates`). Read-only, testable on demo data. | New migration | Small |
| 2 | Recommendation queue: a `gift_recommendations` table, filled weekly by the server, with the AI writing reasons and messages under the server-side check | New migration, new function (or a mode of `ai-suggest-campaigns`), cron | Medium |
| 3 | Gifts page cards, budget setting, approve and skip | index.html (coordinate with the security session), demo seed | Medium |
| 4 | Holdout and "Gifts that worked" results, fed into the Overview and Maya | Migration, index.html, `ai-suggest-campaigns` | Small to medium |
| 5 | Maya knowledge update + MISSION.md, checked with live Q&A | Maya prompt | Small |

Every table gets the usual one-business-only access rules. The approve button never writes money directly: it calls the existing send path, which charges the wallet or Shopify on the server.

## Constraints

- **Review freeze:** don't touch `shopify-app`, the toml, `shopify-oauth-callback`, `shopify-sso` or the billing plans until Shopify's review ends. This feature doesn't need any of them.
- **index.html:** coordinate with the security session. Run `scripts/security/apply_frontend_fixes.py --check`. Check the live site against the repo before deploying. Don't edit `walletStatRows`.
- **Colors:** dashboard text black, green for done, red for warnings, no gold text.

## Decisions for the owner

1. **Plan:** ✅ DECIDED 2026-11-27: **Growth and up** (Growth + Scale). Local doesn't get it. The server checks the plan, not only the page.
2. **Holdout:** ✅ DECIDED: **on by default, 1 in 5**. The owner can turn it off.
3. **Default monthly budget:** ✅ DECIDED: **off until the owner sets one**. Nothing is recommended for spending until a budget exists.
4. **Premium limit:** ✅ DECIDED: **$28**, the most expensive item in today's catalog. The per-customer limit (half of their own average visit) still applies on top.

All four are decided. Ready to build once Shopify's review ends.
