# Spend only where it pays: money rules for every win-back

Scoped 2026-11-28. Plan only: nothing is built yet. These rules sit under every campaign that costs the business money: postcards, store credit, and mailed gifts ([gift recommendations](../gift-intelligence/scope.md) and [store credit](../store-credit/scope.md) both use them).

**The promise to the business:** Clicktide only spends your money when the customer is worth more than it costs to win them back, and it shows you the profit, not just the revenue.

## 1. One new question at setup: "How much do you keep?"
"Out of every $100 a customer spends, about how much do you keep after product and supplies?"

Clicktide has no margin figure today. It only has `business_type`, so it pre-fills a starting guess by type that the owner can adjust:

| Business type | Starting guess |
|---|---|
| Salon, barber, spa, gym, other service | 60% |
| Restaurant, cafe | 65% |
| Retail store | 45% |
| Auto / repair | 50% |
| Anything else | 50% |

That one number turns sales into profit everywhere below.

## 2. What a customer is worth: profit from their next 90 days
Clicktide already knows each customer's own average visit (`customer_visits`) and their usual gap between visits (`customer_rhythm`):

> **Worth** = average visit × visits expected in 90 days × margin

- **Salon client:** $60 every 5 weeks is about 2.5 visits, so $150 × 60% = **$90**.
- **Coffee regular:** $6 weekly is about 13 visits, so $78 × 65% = **$51**.
- **One-time buyer:** no pattern, so the worth isn't trusted and only free touches are sent.

Only 90 days count, because a customer who comes back can drift again. This keeps the estimate on the cautious side.

## 3. The two spending rules

**Rule A: money paid up front (postcards, mailed gifts).** You pay whether or not the customer comes back.
> Up-front spend allowed = chance it works × worth × ½

- **Chance it works** starts at a cautious **10%**.
- It is replaced by the business's own measured rate once at least 30 customers have been sent the touch and 30 held back.
- The ½ means Clicktide keeps at least half of the expected profit for the business.

Examples:
- **Salon client:** 10% × $90 × ½ = $4.50. A $1.50 postcard is fine; a $9.99 magnet isn't yet.
- **Proven gift:** if this business's magnets turn out to bring back 30%, the limit rises to $13.50 and the magnet unlocks.

**Rule B: store credit (paid only if they come back).** The credit must leave the business profit on that visit.
> Minimum spend = credit ÷ (margin × ½)

- **$10 credit at 60% margin:** minimum spend $33, rounded to **$35**.
- **$10 credit at 45% margin (retail):** minimum spend **$45**.

The quick picks fill this in automatically, so "$10 off" is always "$10 off $35+" for a salon.

## 4. Free first, paid only if needed
Each drifting customer goes through these steps. Each one runs only if the last didn't bring them back:
1. **Personal message.** Free.
2. **Store credit** by text or email. Rule B.
3. **Postcard** carrying the credit. Rule A.
4. **Mailed gift.** Rule A, top customers only.

If they come back, everything stops. Nobody gets paid touches that a free one would have done.

## 5. Caps, so a business can never overspend
- **Monthly spend cap:** required before any paid step turns on. It starts empty, so nothing paid runs until the owner sets it.
- **Shown before switching on:** "Most this can cost in a month: $150. It pays for itself if 4 customers come back."
- **"Let go" list:** a customer who went through every step and didn't return gets no more paid touches for 6 months. Clicktide shows them as "worth a personal call" instead, which is free.
- **No discount hunters:** a customer who used a credit and drifted again within 2 of their own cycles gets the free message next time, not another offer.

## 6. Results in profit, and automatic shut-off
- **The results card shows profit:**
  - "Spent $150 · profit from customers who came back $420 · **you're up $270**"
  - "Of those, 6 came back *because of* Clicktide": that's the difference against the held-back group.
- **Auto-pause:** after 30 sends, if a paid step brings back less profit than it costs (measured against the held-back group), Clicktide pauses that step and tells the owner why. Free steps keep running.
- **Monday report:** adds one line, "Clicktide spent $X and brought back $Y in profit this month."

## What has to be built

| # | What | Touches | Size |
|---|---|---|---|
| 1 | Margin question + defaults by business type | New column on `clicktide` (owner-editable), Settings + onboarding (index.html) | Small |
| 2 | Worth per customer + Rule A/B | Database function shared by campaign-runner, gift recommendations and the campaign builder | Medium |
| 3 | Free-first ladder + "let go" + no discount hunters | campaign-runner (the win-back plan already runs day 14/30/45; it gains a "skip if…" check before paid steps) | Medium |
| 4 | Monthly cap + "most it can cost / breaks even at" preview | Campaign builder, Settings | Small |
| 5 | Profit results, comparison group, auto-pause | Results card, Monday report, campaign-runner | Medium |
| 6 | Maya + MISSION.md: explain the rules in plain words | Maya prompt | Small |

Constraints:
- The Shopify review freeze still applies.
- index.html changes are coordinated with the security session.
- The existing AI guard ("gift ≤ half of a high-value visit") stays as a second limit.

## Defaults (change any)
- **Chance it works, before there's data:** 10%.
- **Customer's worth:** next 90 days of profit.
- **Clicktide keeps** at least ½ of the expected profit for the business.
- **Monthly cap:** none until the owner sets one.
- **"Let go":** 6 months.
