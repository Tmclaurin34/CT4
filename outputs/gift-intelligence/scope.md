# Maya Gift Intelligence: scope

Scoped 2026-11-27. Plan only: nothing is built yet. Building starts after Shopify's review is done.

## Works for every business that connects (added 2026-11-28)
**Spend data is there for every connection (checked):** platform-sync reads the order total from Square (`total_money`), Clover (`total`), Stripe (charge `amount`), Shopify and Mindbody. Manual visits and CSV imports fill `customers.total_spent`. Today's data: 72 of 74 customers have spend on file, and 61 are repeat customers. So the moment a business connects its POS or imports a list, Clicktide knows each customer's average spend and rhythm. **No setup questions.**

### Step 1: "Your gift menu" (right after the first sync)
The AI reads the whole customer list and proposes a menu that fits *this* business. The **owner chooses** what stays on it:
- **Store credit amounts** sized to their tickets: salon $5/$10/$15, jeweler $50/$100/$200, and none for a cafe whose tickets are too small.
- **Perks** suggested for their business type: free cleaning, free add-on service, priority booking, free delivery. The owner ticks the ones they're willing to give.
- **Mailed items** from the catalog, with live prices from the nightly price audit: stickers $7.99, magnet $9.99, candle $24.99, tote $27.99. Only the ones that make sense for their customers' value are suggested.
- **Postcards** ($1.50) always available.

Owner actions: **Use this menu** · edit any line · remove anything · add their own perk. The AI never offers something the owner didn't approve.

### Step 2: per-customer recommendations (from the approved menu only)
For each drifting customer, the AI picks **one item from the menu** (or "just a message") using:
- their own average spend
- how often they buy
- how late they are
- how confident the pattern is
- what has worked for this business before

Every card shows the reason, e.g. "Spends about $100 every 4 weeks, 3 weeks late: $10 off $75+." The owner can **Send**, **swap for another menu item**, or **Skip**.

### Minimum spend on every offer (owner's rule, added 2026-11-28)
Nobody gets something for nothing. Every offer the customer redeems in person or online requires a purchase:

| Menu item | Minimum spend |
|---|---|
| Store credit | Required. The larger of: the owner's floor for that item, Rule B (the credit leaves profit), and 75% of the customer's usual spend. $10 credit for a $100 regular = **$10 off $75+** |
| Perk (free cleaning, add-on, priority booking) | Required: **"Free cleaning with any purchase of $X+"**. Set so the perk's cost to the business ≤ ½ × margin × X |
| Gift waiting at the counter | Required: picked up with a purchase of $X+ |
| Welcome / first-visit offers | Required, so a new sign-up can't just collect a freebie |
| Mailed gifts and postcards | Can't require a purchase because they're sent first. So they only go to **proven repeat customers** (3+ visits, see "Who qualifies") and never to first-time or one-time buyers |

- **The owner chooses:** each menu item has a "Minimum spend" field. The AI pre-fills it and the owner can raise it. It can never go below the profit rule.
- **Always in the wording:** every text, email and postcard says "with a purchase of $X or more". The customer knows up front, and the cashier has it in writing.
- **Enforcement, as far as possible with read-only POS access:**
  1. **Setup steps** tell the owner to set the minimum on the code itself in the POS: Shopify's "Minimum purchase amount" is enforced at checkout automatically. Where a POS can't enforce it, the cashier does.
  2. **Redemption check:** once redemptions are tracked, Clicktide reads the order total. If a code was used on an order below the minimum, the owner is told ("MISSYOU10 used on a $22 order") so they can fix the code or remind staff.
  3. **One per customer:** the setup steps also say to turn on "one use per customer". Clicktide never sends the same offer to someone who already used it this cycle.

### Codes can't be reused: one unique code per customer (added 2026-11-28)
A shared code like MISSYOU10 can be forwarded, posted online or used twice. So every offer gets its **own single-use code tied to one customer**, e.g. `BLOOM-7K3Q-MX`, with a QR code in the text, email and postcard.

**In the store (works with any POS, no new permissions):**
1. The customer shows the QR or code.
2. Staff scan it with the business's phone or tablet. This opens Clicktide's **Redeem** screen, signed in as the business, behind a staff PIN.
3. Clicktide checks it and shows one of:
   - **"Valid: Maria Lopez, $10 off $75+, expires Dec 28"**
   - **"Already used Dec 3"**
   - **"Expired"**
   - **"Not for this business"**
4. Scanning marks it used right away (see "Easy for staff" below). Staff then give the $10 discount in their POS as normal.
5. The cashier sees the customer's name, so a forwarded code is obvious.

**Online:**
- **Shopify, later:** unique single-use codes created inside Shopify (a single discount with many codes, each usable once). This needs the `write_discounts` permission, which means changing the app and another Shopify review. Not until the current review is approved.
- **Until then:** online uses the tier code, with Shopify's own "limit to one use per customer" and a total-uses limit. Clicktide flags any repeat use it sees in synced orders.

**Safety:**
- Codes are random: 8+ characters from a 31-character alphabet with no 0/O/1/I. That's over 800 billion possibilities, so they can't be guessed.
- Only the business's own signed-in staff can check or redeem its codes. Each attempt is rate-limited and logged.
- "Mark as used" is atomic, so two scans at the same moment can't both succeed.
- New table `offer_codes`: business, customer, offer, code, minimum spend, expiry, used_at, used_by. Each business sees only its own codes. It replaces the per-tier shared codes for in-store use.
- **Bonus:** redemptions are now exact, so results show precisely who used their offer, with no guessing from POS discount names.

### Easy for staff: nothing to forget (added 2026-11-28)
Staff are busy and will forget an extra tap. So redeeming is **one scan**, and Clicktide closes the code by itself even if nobody remembers:

1. **Scanning redeems it.** There's no separate "Mark as used" button. The staff device scans the QR and the screen goes big and green: **"Give Maria $10 off (purchase $75+)"**. The code is already used. A large **Undo** shows for 2 minutes in case of a mistake (wrong customer, or the sale was cancelled).
2. **Works with the phone's normal camera.** No app to install. The first time, the owner opens "Set up this device for redeeming" on the counter phone or tablet and enters a PIN once. That device is remembered.
   - If a customer scans their own QR, they only see their offer; they can't redeem it.
   - Only set-up staff devices can redeem. The owner can remove a device any time in Settings.
3. **No QR? Type 4 digits.** Staff enter the last 4 digits of the customer's phone, pick the right name from a short list, and tap once. This covers lost texts and forwarded screenshots.
4. **The code closes itself when they come back.** POS sync runs hourly. As soon as Clicktide sees that customer's next purchase, their open offer is closed automatically, scanned or not. This is the safety net: even if staff forget everything, the code can't be used on a second visit. Matching is by the customer's phone, email or card, as POS sync already does.
5. **Shopify online orders** close the code automatically from the synced discount code. No staff involved.
6. **Counter card.** Clicktide gives the business a printable card for the register: "Got an offer? Show us your code." It includes 3-line staff instructions and the setup QR. Maya can explain it to staff too.
7. **No questions for the owner.** The owner won't know every customer, so Clicktide works out whether the credit was given from the order itself:
   - POS orders carry their discount total: Square `total_discount_money`, Shopify `total_discounts`, Clover discounts. platform-sync starts saving it, read-only, with no new permissions.
   - **Unscanned purchase with a discount close to the credit** ($8–$12 on a $10 offer) → counted as **used**.
   - **No discount on that order** → counted as **not used**. The offer still closes, so it can't be used later.
   - **Can't tell** (e.g. the POS doesn't report discounts) → the customer is counted as **returned** (the outcome that matters). For profit, the credit is assumed **given**, so the results never look better than reality.
   - The owner gets a short summary only: "3 offers used today · $30 given · $410 in sales". No per-customer questions.

### Online orders (added 2026-11-28)
**Checked:** every connection today is read-only. Shopify has `read_orders,read_customers`, Square has `ORDERS_READ…`, and Stripe is `read_only`. So Clicktide can't create codes inside any store yet.

**Now, with no new permissions: a personal claim link.**
1. The text or email has a personal link (`goclicktide.com/o/BLOOM-7K3Q-MX`), not a bare code.
2. Tapping it, Clicktide checks the offer is unused, unexpired and this customer's. Then it shows "Your $10 off $75+" and a **Shop now** button. For Shopify, that button uses Shopify's discount link, so the code is already in the cart.
3. The store itself enforces the minimum spend and **"one use per customer"**. Shopify checks that by the customer's email and account.
4. **Closes automatically:** when the synced order shows the code, Clicktide closes that customer's offer. No staff involved.
5. **Leak protection for the code underneath:**
   - If an order uses the code from an email that was never sent the offer, the owner is told: "MISSYOU10 used by someone who wasn't sent it."
   - The tier codes **rotate monthly** (MISSYOU10-DEC → -JAN), so a leaked code stops working at month end. The setup steps include the 1-minute monthly swap. Clicktide reminds the owner and updates its own links.

**Later: one-time codes created inside the store, one per customer, usable once.**

| Online store | How | Needs |
|---|---|---|
| Shopify | One discount with many unique codes, each usable once, with minimum subtotal and expiry, and limited to that customer | `write_discounts` permission, which means changing the app and another Shopify review. Only after the current review is approved. |
| Stripe checkout | Promotion codes support "use once", "only this customer" and "minimum amount" | Businesses reconnect Stripe with write access |
| WooCommerce / Wix (when those apps exist) | Coupon APIs support one use and email restrictions | Part of building those apps |
| Square Online | No dependable coupon API found | Claim link + rotation, as above |

Once these exist, online codes are airtight like the in-store scan, and the claim link keeps working the same way for the customer.

### Codes are Clicktide's proof (added 2026-11-28)
Today's "won back" number (Overview, `clicktide_winback_stats`) counts customers who returned *after* a message. That shows they came back, but not that the message caused it. One-time codes make the link direct, in three levels:

| Level | Meaning | Source |
|---|---|---|
| **Brought back (proven)** | Used *their own* code: this exact message brought this exact visit | Scan, claim link, or a discount on the order |
| **Brought back (helped)** | Got a message and returned, without using the code | Today's return-visit tracking |
| **Would have anyway** | Return rate of similar customers who were held back | Comparison group |

What it shows:
- **For the business (Overview + Monday report):**
  - "Clicktide brought back **14 customers** this month: **9 proven** by their codes, 5 helped. **$1,260** in sales, **$650** profit after offers."
  - **Do they stay?** Of customers won back, how many are still visiting on their usual rhythm 30, 60 and 90 days later (the rhythm engine already tracks this). "11 of 14 are back on schedule."
  - **What works best:** by channel (text, email, postcard), by offer ($5 or $10, perk or cash), and by how late the customer was.
- **For Clicktide (sales and the App Store listing):**
  - Real case studies like "Bloom Salon: 40 offers, 9 came back, $650 profit", only with that business's permission.
  - Platform totals across all businesses ("Clicktide businesses won back 1,200 customers") only as anonymous sums, and only if the privacy policy and terms allow it. Check before publishing.
  - This is the "proven results" piece that's been missing.

**Keep the results screen simple (owner's decision, 2026-11-28):** less is more.
- **Main view:** three numbers only, in plain words:
  - customers who came back after Clicktide reached out
  - what they spent
  - profit after offers

  Plus one recent comeback ("Maria came back, $96").
- **Early on** (fewer than ~20 offers sent, or under 3 weeks), show "Results start showing in about 2 weeks" instead of small or zero numbers.
- **Kept off the main screen but still used:** the comparison group, the proven/helped split, and the channel and offer breakdowns. Maya and the auto-pause use them behind the scenes, and they're one tap away under **See details** for owners who want them.
- **Stay truthful:**
  - Wording says "came back after Clicktide reached out", never "because of".
  - Profit is always after what was spent.
  - When something isn't paying off, Clicktide fixes it and says so in one line: "We paused postcards. They weren't paying for themselves, so your money goes to texts instead." Owners trust a tool that protects their money.

### Who decides what
| Decision | Who |
|---|---|
| What's on the menu | **The owner**, from AI suggestions |
| Monthly spending limit | **The owner** |
| Which customer gets which menu item | AI suggests, **the owner approves** (or turns on auto-send within the limit) |
| Limits (profit rules, minimum spend, discount hunters) | The server, always |

This merges gift recommendations and store credit into one system: one menu and one queue of recommendations. Physical gifts, credits, perks and postcards are all just menu items.

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
