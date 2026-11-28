# Win-back autopilot: everything sets itself up when a business connects

Scoped 2026-11-28. Plan only: nothing is built. Building waits for Shopify's review to finish.

This ties the other plans into one automatic flow:
- [gift recommendations + menu + codes](../gift-intelligence/scope.md)
- [store credit](../store-credit/scope.md)
- [spending rules + budget](../business-roi/scope.md)
- [link for texts](../text-link/scope.md)

## The one rule we keep: nothing is sent or spent until the owner taps Start
The Shopify listing promises "Nothing is sent until you switch a campaign on". The win-back playbook was fixed on 2026-11-27 precisely because it had switched itself on. So the autopilot prepares everything automatically and the owner starts it with **one tap**. After that tap, it runs itself.

## What happens automatically after they connect (no owner input)

| When | What Clicktide does | Uses what already exists |
|---|---|---|
| First sync finishes (minutes) | Imports customers and orders, works out each customer's average spend and rhythm | platform-sync, `customer_visits`, `customer_rhythm` (nightly job; run it once right after the first sync) |
| Right after | Works out margin (from business type), each customer's worth, and the natural comeback rate from their own history | Spending rules, section 0 |
| Right after | AI builds the **gift menu**: credit amounts sized to their tickets, perks for their business type, catalog items at live prices, postcards. Every item has a minimum spend | Gift plan "Your gift menu"; nightly price audit |
| Right after | Builds the **plan**: free message → credit → postcard → gift for top customers, timed to each customer's rhythm | Win-back playbook (day 14/30/45), now rhythm-timed |
| Right after | Recommends the **budget** (Starter / Recommended / Everything), using plan-included postcards and texts first | Spending rules, section 7 |
| Right after | Pre-fills the **link for texts** (Shopify store address, else website) and writes the messages in the business's voice | Text-link plan; Maya |
| Ready | Shows **one card**: "Your win-back plan is ready" | New |

## The one card the owner sees

> **Your win-back plan is ready**
> We found **23 regulars** who are slipping away, worth about **$2,100** a year to you.
> Plan: a friendly message first, then a $10 credit (on $75+), then a postcard for your best customers.
> Budget: **$90/month**, expected to bring back about 7 customers and about $500 profit.
> **[Start]** · Review details

- **Start** turns everything on.
- **Review details** shows the menu, the messages and the budget. The owner can change anything there, but doesn't have to.
- With no tap, nothing happens. A gentle reminder comes after 3 days, and again after a week, then it stops.

## After Start: what keeps running by itself

- **Hourly:** new orders sync; customers who come back stop getting messages; used codes close.
- **Nightly:**
  - rhythms update
  - newly drifting customers enter the plan
  - gift prices are re-checked
  - spending is paced through the month
- **When a step is due:** messages, credits and postcards go out within the budget, quiet hours and consent rules. Each customer gets a single-use code.
- **Weekly (Monday):** Maya's short note shows results, the next month's suggestion and any one-tap boost. Losing steps are paused automatically, with a one-line explanation.
- **Monthly:** the budget is reviewed. **Increases always need the owner's tap**; decreases and pauses happen automatically to protect their money.

## What still needs the owner (kept to the minimum)

| Owner action | How often |
|---|---|
| Tap **Start** | Once |
| Create the reward codes in their POS (tiers + perks), or skip and use message-only plus postcards | Once (a few minutes, step by step). Later, automatic where write access exists (Shopify `write_discounts` after a review) |
| Set up the counter phone for scanning (PIN) | Once |
| Approve a budget increase or a boost | When suggested |
| Mailed gifts above the menu's limits | Never automatic |

## What has to be built (on top of the other plans)

| # | What | Touches | Size |
|---|---|---|---|
| 1 | "On first sync done" trigger: run rhythm + menu + budget + plan for that business right away | platform-sync, rhythm job, new orchestration step (edge function) | Medium |
| 2 | The "plan is ready" card, the Start button, reminders | index.html (coordinate with the security session), owner-alerts/email | Small |
| 3 | Autopilot state per business (`ready` / `running` / `paused`) and an audit log of what it did | Migration | Small |
| 4 | Weekly/monthly loop wired into `ai-suggest-campaigns` + Monday report | Edge functions | Medium |
| 5 | Maya + MISSION.md | Maya prompt | Small |

## Constraints
- Review freeze until Shopify approves.
- Customer consent and quiet hours are unchanged: texts only go to opted-in customers in their window.
- Test stores and Shopify trial stores stay blocked from paid sends, as today.
- Every paid step follows the spending rules. The AI never raises spend, and never invents numbers.
