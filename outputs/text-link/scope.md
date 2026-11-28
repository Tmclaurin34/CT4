# "Link for texts": scope

Scoped 2026-11-28. Plan only: nothing is built. Building waits for Shopify's review to finish.

## The idea
Each business saves one link in Settings for customers to act on: book, order, shop, or get directions. Win-back texts can then include it, written as `{{link}}`, so the customer can tap straight through. The link is the business's own address, never a link shortener and never routed through Clicktide.

## Checked today
| Fact | Detail |
|---|---|
| Businesses with a website saved | **0 of 11.** The `clicktide.website` column exists, and Settings has a Website field (`pfSite`). |
| Links in texts today | Only a reward link, through the Digital Gift "Online link" field (campaign-runner `rewardBlocks()`), and the gift-address link to goclicktide.com |
| Text placeholders | campaign-runner `fillTemplate()` knows only `{{first_name}}` and `{{business_name}}` |
| STOP wording | Added automatically if missing (campaign-runner) |
| Length | send-customer-sms counts segments: 160 GSM characters, or 70 if any emoji. Up to 6 segments, each billed. |
| Businesses registered for customer texts | **0.** Only Clicktide's own platform registration exists. Links can be declared from each business's first registration, so nothing has to be re-registered. |

## What gets built

### 1. Settings: "Link for texts"
A new field under the Website field: **"Link customers should tap in texts"**, with help text "Your booking, ordering or shop page".
- **Saved as:** a new column `clicktide.sms_link`. Kept separate from `website` because the best link is often a booking page, not the homepage.
- **Checks on save** (server-side too, through a database check):
  - Must be `https://`, a real domain, at most 120 characters.
  - **Public shorteners are refused** (bit.ly, tinyurl, t.co, goo.gl, ow.ly, is.gd, buff.ly, rebrand.ly, cutt.ly, shorturl.at, and similar). The message says: "Carriers often block shortened links. Use your own website address instead."
  - goclicktide.com links are refused, so one shared domain can't get blocked for everyone.
- **Pre-filled:**
  - Shopify stores get their store's address.
  - Otherwise, the Website field if it's filled in.
  - Otherwise, it stays empty.
- **"Test this link" button:** checks that the page opens (status 200) through a small server check, so the owner doesn't send a broken link.

### 2. `{{link}}` in messages
- **campaign-runner `fillTemplate()`:** gains `{{link}}`. It becomes the business's saved link. If none is saved, the placeholder and the words around it are dropped cleanly, e.g. "Book here: {{link}}" is removed entirely.
- **Campaign builder, step 3:** an "Add my link" chip inserts `{{link}}`.
- **Library and playbook text templates:** gain an optional line such as "Book here: {{link}}". It shows only when a link is saved.
- **One link per text:** if a Digital Gift reward link is also present, the text uses the reward link (it applies the discount) and drops `{{link}}`. The email still shows both.

### 3. Length guard
The campaign builder's preview shows the length with the link filled in: "1 text" / "2 texts (costs double)". It warns when a link pushes a text past one segment and suggests trimming the wording. Nothing is blocked: the existing 6-segment cap still applies.

### 4. Texting registration checklist
Update `~/Desktop/sms-per-business-setup.txt`, and the automated registration when it's built:
- **"Message contents":** tick **Embedded links: YES**.
- **One sample message gets the business's real link:** e.g. "[Business]: We've missed you! Enjoy 15% off your next visit, code SAVE15. Book here: [their link] Reply HELP for help, STOP to opt out."
- **The link's domain must match the business's website** in its brand registration.
- **Intake form (`a2p-register`):** adds "the link you'll send in texts" so it's declared from day one.

### 5. Maya + MISSION.md
Teach Maya the "Link for texts" setting, why shorteners are refused, and the one-link rule. Check it with live Q&A.

## Not doing (and why)
- **Click tracking through a Clicktide short link:** one shared domain across every business means one bad sender could get it filtered for all of them. It also doesn't match each business's brand. Revisit later with a per-business branded domain if proof of clicks is needed. Returns are already measured by visits.
- **Fashion-Nova style copy** (caps, sirens, countdowns): local businesses win by being personal, and pushy texts get filtered and reported more. Templates stay friendly and short.

## Build order and size

| # | What | Touches | Size |
|---|---|---|---|
| 1 | `sms_link` column + server-side check | Migration | Small |
| 2 | Settings field, pre-fill, Test-link | index.html (coordinate with the security session; `apply_frontend_fixes.py --check`; compare live vs repo before deploy), small link-check function | Small |
| 3 | `{{link}}` placeholder, one-link rule | campaign-runner + send-customer-sms (they share a block byte for byte: change both), library templates | Small |
| 4 | Length preview | index.html | Small |
| 5 | Registration checklist + intake field | Desktop checklist, `a2p-register` | Small |
| 6 | Maya sync | Maya prompt, MISSION.md | Small |

All six are small. Together they're about a day of work, plus testing (a dry run of campaign-runner, and a test text to an owner's own phone).

## Decisions (defaults, change any)
- **Field name:** "Link for texts".
- **Shopify stores:** pre-filled with the store address.
- **Shorteners and goclicktide.com links:** refused.
- **When there's no link:** templates drop the line. They never send "{{link}}" or an empty "Book here:".
