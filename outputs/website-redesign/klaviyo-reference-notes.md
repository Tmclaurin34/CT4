# Website redesign: Klaviyo reference notes (2026-11-27)

These notes come from klaviyo.com (public homepage) and the owner's new Klaviyo account setup screen, both viewed in Chrome. Nothing was changed in the Klaviyo account; its setup is paused at "Add your business address".

## What Klaviyo does that we want
- **Layout:** white background, a lot of empty space and a centered column.
- **Color:** one bold accent color used rarely (theirs is orange-red).
- **Header:**
  - thin top banner for news;
  - simple top menu: Products, Integrations, Solutions, Resources, Pricing;
  - "Log in ↗" as a text link and **Sign up** as a solid black button.
- **Hero:**
  - a small uppercase label above the headline ("THE AUTONOMOUS B2C CRM");
  - a big light-weight headline over 2–3 lines;
  - one plain sentence underneath;
  - two buttons: Sign up, and Sign up with Google;
  - on the right, a **real product screenshot with a big money number** ("$843,132.05 attributed revenue, ↑18%").
- **Section pattern:**
  - a centered headline, then one sentence;
  - then 2-up cards: grey panel, product UI inside, short paragraph and an underlined "Explore X ↗" link.
- **Type:** a thin, elegant sans-serif for headings and plain body text. No emoji; small line icons.
- **Their setup flow:** one question per screen, a centered narrow form, one black Continue button and a ← Back link.

## How it translates to Clicktide
- **Hero:**
  - label: "CUSTOMER RETENTION FOR LOCAL BUSINESSES";
  - headline: "Win back the regulars who stopped coming in";
  - right side: the Overview card with the real "Recovered $X · N customers came back" number.
- **Accent color:** Clicktide gold, used sparingly. Buttons are near-black like Klaviyo's.
- **2-up cards:**
  - "Knows each customer's rhythm" (Customer Intelligence screenshot);
  - "Sends a text, a postcard, then a gift" (campaign builder plus postcard and gift photos);
  - "Works with your POS" (logos);
  - "Billed through Shopify / one simple plan".
- **Keep what makes Clicktide different:** real postcard and branded gift photos, which Klaviyo can't show.
- **Pricing:** 3 cards (Local $79 / Growth $199 / Scale $449), each with a FAQ.

## Rules for the build
- Build on the preview alias first (preview.clicktide-app.pages.dev). Change nothing on goclicktide.com until the owner approves.
- The marketing and landing part of index.html only. Leave the dashboard alone until the Shopify review is approved.
- Before shipping, run `scripts/security/apply_frontend_fixes.py --check`. It must report 0 to apply, so that Turnstile, MFA and the auth-accept and SSO handlers survive.

---
# OWNER'S PICK (2026-11-27): Droplist style (trydroplist.com, via saaspo.com/pages/droplist-landing-page)
What it does:
- **Page:** almost all white and very calm.
- **Headline:** a short, bold, rounded, friendly headline centered over 2 lines, with a grey one-liner under it.
- **Button:** ONE bright orange pill button ("Try for free"). Login is a small outlined pill at the top right.
- **Logo:** a small colorful wordmark.
- **Annotation:** a handwritten "try it out! ↷" note with an arrow pointing at the demo, which gives it a human touch.
- **Hero demo:** a big live, clickable product board inside a rounded frame set on a warm dark photo background.
- **Persona tabs** under the demo ("Creative / Founder / Busy mom / Engineer / Student") switch what the demo shows.
- **Sections:** a small colored pill label (e.g. "Today"), a short bold heading, then a light-grey rounded panel holding a simplified product mock.
- **Tags:** soft pastel pills (orange, blue, green) inside the cards.

Clicktide version:
- **Headline:** "Clicktide wins back the regulars who stopped coming in". One-liner: "texts, postcards and gifts that go out on their own when a customer drifts".
- **Button:** one gold-orange pill, "Start free trial". "Log in" is a small outlined pill.
- **Demo:** the handwritten "try it out ↷" arrow pointing at a LIVE demo of the dashboard. Demo mode (?demo=1) already exists, so a simplified embedded board is possible.
- **Persona tabs:** "Salon / Gym / Café / Boutique / Auto shop" switch the demo's sample business.
- **Pills:** Healthy (green), Drifting (amber), At risk (red), Came back (blue). This matches the owner's dashboard color rule (green = good, red = warning).
- **Section labels:**
  - "Rhythm": learns each customer's own visit pattern;
  - "Win-back": day-14 text, day-30 postcard, day-45 gift;
  - "Results": "$812 recovered";
  - "Works with": POS logos.
- **Keep:** the real postcard and gift photos in one section.
- **Fonts:** a friendly rounded bold for headings (e.g. "Bricolage Grotesque" or "Nunito" 800), DM Sans for body text.
