# Spend only where it pays: money rules for every win-back

Scoped 2026-11-28. Plan only: nothing is built yet. These rules sit under every campaign that costs the business money: postcards, store credit, and mailed gifts ([gift recommendations](../gift-intelligence/scope.md) and [store credit](../store-credit/scope.md) both use them).

**The promise to the business:** Clicktide only spends your money when the customer is worth more than it costs to win them back, and it shows you the profit, not just the revenue.

## 0. No input needed (decided 2026-11-28)
The business doesn't have to type anything. Every number comes from data Clicktide already has. The margin question in section 1 becomes **optional**: it's a "make it more accurate" setting, not a setup step.

| Number | Where it comes from automatically |
|---|---|
| Average visit | Each customer's own POS orders (`customer_visits`) |
| How often they visit | `customer_rhythm.expected_interval` |
| How many are drifting | `customer_rhythm.status` |
| **Would come back anyway** | **Their own history.** Of past times a customer went past 1.5× their usual gap, how many came back within 30 days with no message. Checked on the test business: 26 past drift episodes, 2 came back on their own (7.7%). |
| Come back with the offer | Starts at "would anyway" + 5 points, a cautious guess. Replaced by the measured holdout rate after 30/30. |
| Margin | `business_type`, already asked at signup: nails, barber, gym, yoga… "Other" (5 of 11 today) uses a **cautious 40%**, so profit is never overstated. Reading real product costs from the POS later would need extra permissions (Shopify `read_products`/inventory means another app review), so it's not in this version. |
| Credit amount | About 15% of the business's typical visit, rounded to $5: a $33 average gives a $5 credit, $60 gives $10. |
| Minimum spend | Section 3, Rule B, from the margin above |

The owner sees: "Based on your last 12 months: a $5 credit on $25+ should bring back about 3 extra customers a month and leave you about $X ahead. Turn it on?" One tap. The numbers are shown, never asked for.

## 1. Optional: "How much do you keep?" (it used to be a setup question): "How much do you keep?"
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

## 7. Recommending a budget (added 2026-11-28)
Owners don't know what to spend, so Clicktide works it out from their own data and offers **three choices with one pre-selected**. Nothing is typed in.

**How it's worked out, monthly:**
1. **Who's worth a paid step:** customers expected to start drifting this month (from rhythm) who pass Rule A/B: repeat customers with enough worth.
2. **Expected cost** for each, through the free-first ladder:
   - credits count only at their expected use (e.g. 30% × $10 = $3)
   - postcards and gifts count at full cost
   - what the plan already includes is used first: Local 10, Growth 30, Scale 75 postcards and their included texts
3. **Expected return:** worth × expected comeback rate (the cautious default until the business has its own results).

**Scales with the business (owner's point, 2026-11-28):** every option is computed from the business's own customer count, drifting count and typical ticket, never a fixed price list.
- More customers means more drifting customers and a bigger recommended budget.
- A bigger ticket means a bigger credit, sized to the visit.
- When the expected texts or postcards go past what the plan includes, the card says so and, where cheaper, suggests the next plan ("Scale may cost less for a business your size").

**The three options:**

| Option | Who it covers | Example (salon, sample) |
|---|---|---|
| **Starter** | Only the most valuable customers at risk (top 20%) | $40/mo → about 3 back → about $220 profit |
| **Recommended** (pre-selected) | Everyone who passes the profit rules | $90/mo → about 7 back → about $500 profit |
| **Everything** | Every eligible customer, postcards included | $160/mo → about 9 back → about $600 profit |

Each line says "about" and comes from the business's own numbers. The owner taps one. "Change amount" is there but never required.

**The budget adjusts itself:**
- **Paced:** spending is spread across the month, so the budget isn't gone by day 5. The owner is told at 80%.
- **Grows when it works:** after a month with results, "Every $1 brought back about $5 in profit last month. Raise to $150?" One tap. It never raises itself without that tap.
- **Shrinks when it doesn't:** steps that aren't paying are paused automatically (section 6). The budget is never spent just because it's there: unspent money stays with the business.
- **Never more than it can earn:** the recommended amount is capped so the expected profit is at least 2× the spend.

**Where AI helps with the budget (Maya):** the server computes every dollar figure and limit. The AI plans, times and explains on top of that.
- **Reads the season:** from the business's own past sales it sees slow months coming, e.g. "January is usually 30% slower for you". It suggests spending a little more just before them and less in naturally busy weeks, when regulars come back anyway.
- **Picks the mix:** each month it shifts the same budget toward what works for *this* business. More postcards if postcards bring people back, more texts if texts do, more perks for a high-ticket shop.
- **Writes the monthly recommendation** in plain words: "Last month $90 brought back 7 customers and $500 profit. December is usually busy for you, so we suggest keeping $90. In January, raising to $130 could bring back about 4 more."
- **Answers questions** in the Maya chat: "Should I spend more?", "Why did you pause postcards?", "What if I only spend $50?" Answers come from the business's own numbers.
- **Flags opportunities:** "12 of your best customers are about to drift. A $40 boost this week covers them." One tap to approve.

**What the AI can't do:**
- raise the budget without the owner's tap
- go past the profit cap (expected profit at least 2× spend) or the monthly limit
- invent numbers: every figure it shows comes from the server's calculation

It runs with the weekly AI suggestions job (`ai-suggest-campaigns`, Mondays) and appears in the Monday report.

**Wording for the owner:** "We recommend $90 a month. Based on your customers, that should bring back about 7 people and about $500 in profit. You only pay for what's sent, credits only when they're used."

## 8. Full cost calculation: texts, emails, postcards, gifts, credits (added 2026-11-28)
The budget and the "plan is ready" card count **everything**, using the real plan allowances and prices (checked in index.html, send-customer-sms and campaign-runner on 2026-11-28):

| Item | Included in plan | Extra cost (paid to Clicktide) |
|---|---|---|
| Email | Unlimited on every plan | $0 |
| Text | Local: none (texting is Growth+). Growth: 1,500/mo. Scale: 5,000/mo | $0.05 per text after that. Counted per text sent (`clicktide_sms_usage`), not per segment |
| Postcard | Local 10, Growth 30, Scale 75 per month | $1.50 each |
| Mailed gift | None | Catalog price (audited nightly): stickers $7.99, magnet $9.99, candle $24.99, tote $27.99 |
| Store credit / perk | n/a | **$0 to Clicktide.** It's a discount the business gives at checkout, only when used. Shown separately as "credit given" |

**How the estimate is built** (per month, from the business's own data):
1. Drifting customers expected this month (rhythm).
2. Ladder steps each one is likely to reach. Most stop early because they come back. Each step's texts, emails and postcards are counted.
3. Allowances are used first. Only what's beyond them costs extra.
4. Gifts only for customers who pass Rule A.
5. Credits at expected use, shown as "given at checkout", not as a Clicktide bill.

**What the owner sees:** "About $15 extra this month (10 postcards beyond your 30). Texts and emails are covered by your plan. About $200 in credit will be given at checkout, only to customers who come back and spend $75+."

**Note for Clicktide's own margin:** Twilio bills Clicktide per *segment*, but a customer's allowance is counted per text. Keeping templates to one segment (the length preview in the text-link plan) protects Clicktide's cost.

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
