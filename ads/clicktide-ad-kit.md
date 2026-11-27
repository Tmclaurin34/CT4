# Clicktide Free POS Audit — Ad Kit

Everything below points to the live page **goclicktide.com/free-pos-audit**. Images are in `ads/images/` (3 sizes per ad).
All example numbers in the images are labelled EXAMPLE and come from a fictional café.

---

## 1. Meta (Facebook + Instagram)

### Campaign setup

| Setting | What to choose |
|---|---|
| Campaign objective | **Traffic** → optimize for **Landing page views** (switch to Leads/Conversions only after a Meta Pixel is added) |
| Campaign name | `Clicktide – Free POS Audit` |
| Special ad category | None |
| Budget | $40/day total (≈ $1,200/month) — split across the 2 ad sets below |
| Placements | Advantage+ placements (Feeds, Stories, Reels). Images are provided for each. |
| Run time | Let it run **7 days** before judging; don't edit ads in the first 3 days |

### Ad set A — Salons & barbers ($20/day)
- **Location:** _your choice_ — recommended: start with one metro area you know (e.g. New York City + 25 mi), then expand.
- **Age:** 25–65
- **Detailed targeting** (pick what Meta offers): job titles *Salon owner, Hair stylist, Barber, Salon manager*; interests *Beauty salon, Barbershop, Hair salon, Square (POS), Small business owners*.
- **Ads:** Ad 4 (Salon) + Ad 2 (Rhythm)

### Ad set B — Local business owners ($20/day)
- **Location:** same as A
- **Age:** 25–65
- **Detailed targeting:** *Small business owners, Business page admins*; interests *Square (POS), Shopify, Clover, Local business, Customer retention*.
- **Ads:** Ad 1 (Report) + Ad 3 (Automation)

### The four ads

Use **Learn More** as the button on every ad. In each ad's **URL parameters** field paste:
`utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`
(Meta fills these in automatically, so your Clicktide funnel report shows which ad and placement brought each audit.)

---

**Ad 1 — Report** · images `clicktide-report-*.png`
- **Ad name:** `report`
- **Website URL:** `https://goclicktide.com/free-pos-audit?v=1`
- **Primary text:**
  > Your POS already knows which customers stopped coming back. Clicktide only reads it and shows you who's drifting away and what they used to spend — free, in about 5 minutes. No credit card.
- **Headline:** Get your free retention report
- **Description:** Free POS audit · No credit card

---

**Ad 2 — Rhythm** · images `clicktide-rhythm-*.png`
- **Ad name:** `rhythm`
- **Website URL:** `https://goclicktide.com/free-pos-audit?v=2`
- **Primary text:**
  > A regular who used to come in every two weeks hasn't been back in a month. Would anyone notice? Clicktide learns each customer's own visit rhythm from your POS and flags who's slipping away. Free report, no credit card.
- **Headline:** Know who stopped coming back
- **Description:** Free POS audit · About 5 minutes

---

**Ad 3 — Automation** · images `clicktide-auto-*.png`
- **Ad name:** `auto`
- **Website URL:** `https://goclicktide.com/free-pos-audit?v=3`
- **Primary text:**
  > See which customers are drifting away — free. Then, if you choose, Clicktide brings them back with a personal message, a reward, a postcard or a gift, and counts only the customers who actually return.
- **Headline:** Bring regulars back automatically
- **Description:** Start with a free POS report

---

**Ad 4 — Salons & barbers** · images `clicktide-salon-*.png`
- **Ad name:** `salon`
- **Website URL:** `https://goclicktide.com/free-pos-audit?v=2`
- **Primary text:**
  > Some clients book every 4 weeks, others every 8. Clicktide learns each client's own rhythm from your POS and shows you who's overdue — before they find another chair. Free report, no credit card.
- **Headline:** Which clients haven't been back?
- **Description:** Free salon & barber POS audit

---

### Retargeting ($200/month, start in week 2)
Create a **Custom Audience → Website visitors** only after adding the Meta Pixel (see section 4). Until then, skip retargeting.

---

## 2. Google Search ($400/month ≈ $13/day)

- **Campaign type:** Search · **Bidding:** Maximize clicks (max CPC $3) for the first 2 weeks
- **Location:** same as Meta
- **Final URL:** `https://goclicktide.com/free-pos-audit?v=1&utm_source=google&utm_medium=cpc&utm_campaign=pos_audit_search`

### Keywords (phrase match)
- "customer retention software"
- "customer retention for small business"
- "win back lost customers"
- "salon client retention"
- "barbershop client retention"
- "customer loyalty software for small business"
- "square customer retention"
- "clover customer retention"
- "how to get customers to come back"

### Negative keywords
jobs, career, salary, course, certification, definition, free template, pdf, enterprise, b2b saas

### Responsive search ad
**Headlines (≤30 characters each):**
1. Free POS Retention Report
2. See Who Stopped Coming Back
3. Find Your Drifting Customers
4. Works With Square & Clover
5. Also Shopify, Stripe or CSV
6. Free · No Credit Card
7. Report in About 5 Minutes
8. Win Back Regular Customers
9. For Salons, Barbers & Cafés
10. Clicktide Retention Audit
11. Each Customer's Own Rhythm
12. Only Reads Your Sales Data
13. Nothing Sent to Customers
14. Bring Regulars Back
15. Get Your Free Report

**Descriptions (≤90 characters each):**
1. Connect your POS and see which regulars are drifting away and what they used to spend.
2. Clicktide learns each customer's own visit rhythm — no one-size-fits-all timer.
3. Free report, no credit card. Clicktide only reads your sales data and never moves money.
4. Then, if you choose, win them back with messages, rewards, postcards and gifts.

---

## 3. What to measure (and how)

Your funnel tracking already records every step by ad (`utm_content` = ad name):

landing view → button click → account created → POS connect started → connected → report completed → report viewed → plans viewed → checkout started → paid

**Judge ads by cost per completed report and cost per paid customer — not clicks.** After 7 days, ask Claude to "pull the free audit funnel by ad" (it runs `clicktide_audit_funnel`).

Rough first targets to sanity-check (assumptions, not benchmarks): under $40 per completed report; pause any ad with 0 completed reports after ~$150 spend.

---

## 4. Before you spend — checklist

- [ ] Do one real sign-up on goclicktide.com/free-pos-audit and upload `demo/demo-cafe-orders.csv` (or connect a real POS) — confirm the report appears.
- [ ] Facebook Page + Instagram business account for Clicktide (logo, cover, website, short description).
- [ ] Meta Business account with an ad account and payment method.
- [ ] Verify the domain goclicktide.com in Meta Business settings (Brand safety → Domains; add the TXT record in Cloudflare DNS).
- [ ] Choose locations (section 1).
- [ ] Optional, later: Meta Pixel + Conversions API so Meta can optimize for completed reports (needs a cookie-consent update on the site; ask Claude).
- [ ] Clover: confirm the Clicktide app's permissions are read-only in the Clover developer dashboard.
