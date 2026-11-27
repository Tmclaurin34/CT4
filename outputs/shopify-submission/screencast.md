# Screencast

**Upload this file:** `outputs/shopify-screencast/clicktide-shopify-review-screencast-UPLOAD-THIS.mp4`.
- It's a standard MP4 (moov/mdat). It was remuxed losslessly with `avconvert --preset PresetPassthrough` from the MediaRecorder recording, which was fragmented and reported a wrong duration.
- If you re-record, repeat that step.
- 2:53, 1920×1080, MP4 (H.264), no audio, English captions on every scene.
- It's made from real screens: the dev store's Shopify admin and goclicktide.com, plus a labeled sample-data section.

**Where to host it:** YouTube, as **Unlisted**. Shopify's form says to link YouTube or a video file that opens without a sign-in. It can't open Google Drive or Vimeo links.

**Length:** Shopify suggests "aim for 3 to 8 minutes". This is 2:53 and covers onboarding, billing, the core features, and the customer side. If a reviewer asks for more, extend it with a live campaign send on a paid (non-dev) store.

**Credentials:** the video shows no login credentials. The Shopify account's name and email in the admin sidebar are blurred.

## Scene order (what a fresh install looks like)
Install → store-named confirm → dashboard (no setup wizard) → choose a plan in Shopify → core features → customer side → reopen from the admin.

| Time | Section | Scene | Caption |
|---|---|---|---|
| 0:00 | Title card | Clicktide for Shopify | Install, sign-in, billing and core features |
| 0:05 | Store | A development store with two paid orders | Clicktide is then installed from its App Store listing (here, its install link). |
| 0:11 | Install | Shopify's permission screen | Clicktide asks to view customers, orders and the store owner's contact. The merchant clicks Install. |
| 0:19 | Sign-in | Clicktide confirms the store before it opens | It names the store and asks first. There is no sign-up form and no password to create. |
| 0:26 | Sign-in | Signed in to the store's own Clicktide account | The store's Shopify orders are already imported ($165). Sending needs a plan, so the merchant clicks Choose a plan. |
| 0:34 | Billing | Plans are chosen and billed in Shopify | Shopify Managed Pricing: Local, Growth or Scale, with a 30-day free trial. Free on development stores. |
| 0:41 | Billing | Shopify's own approval page | It shows the plan and its usage rates, such as postcards and extra texts. The merchant approves. |
| 0:49 | Billing | Back in Clicktide with the plan active | The win-back plan is running on the store's 2 customers. Extras are billed by Shopify. |
| 0:56 | Customers | Customers imported from Shopify orders | Each customer gets a score, a status and the next best action. |
| 1:03 | Customers | Customer Intelligence | Clicktide learns each customer's own rhythm. With one order so far, it uses an estimate. |
| 1:09 | Campaigns | Campaigns | A welcome journey and a library of ready-made campaigns. The day 14 / 30 / 45 win-back plan is on and can be edited or paused. |
| 1:17 | New campaign | Step 1: when it sends | Pick the moment, for example 30 days without an order. |
| 1:23 | New campaign | Step 2: what to send | A message, reward code, survey, branded gift or mailed postcard. Postcards are $1.50 each, billed through Shopify. |
| 1:31 | New campaign | Step 3: write the message | The merchant picks how the message goes out (here, email) and sees the postcard exactly as it will be printed and mailed, in the store's name and brand color. |
| 1:39 | Customer side | The email customers receive is designed here | Email Studio: the store's own email layout. Each customer's name and message are filled in when a campaign sends. |
| 1:46 | Customer side | What the customer receives (sample) | Sent in the store's name, with one-click unsubscribe and the store's address. A customer who orders again stops getting win-back messages. |
| 1:55 | Billing | Usage & billing | Everything is billed through Shopify; nothing is charged to a card in Clicktide. Development stores are not billed. |
| 2:02 | Reopen | Open Clicktide any time from the admin | Settings → Apps → Clicktide. |
| 2:08 | Reopen | Billing and access show in Shopify too | Free trial on the Local plan, and view-only access to customers and orders. Open app signs the merchant straight back in with a one-time code. |
| 2:14 | Title card | More of the product | Shown with sample data: a store with months of order history |
| 2:19 | Sample data | Overview: what is at risk and what came back | Revenue drifting right now, and customers who returned after a Clicktide message. |
| 2:27 | Sample data | Who is drifting, and the plan that runs | Clicktide learns the store's rhythm, then sends a day-14 text, a day-30 postcard and a day-45 gift. |
| 2:35 | Sample data | Gifts with the store's logo | Branded products, ready to send to any customer. |
| 2:41 | Sample data | Shipments, tracked to the door | Every gift is tracked from production to delivery. |
| 2:48 | Title card | Clicktide | Uninstalling from the Shopify admin stops Clicktide's access to the store right away |

## How it was made (to re-record)
1. **Real screens:** captured from Chrome on `clicktide-install-test`.
2. **Sample-data screens:** captured from goclicktide.com's demo mode, set to render as a Shopify-billed store.
3. **Customer email:** rendered from the same markup as `send-customer-email`.
4. **Video:** composed on a canvas and recorded with headless Chrome's MediaRecorder. There's no ffmpeg on this Mac.

The scene list and renderer are saved next to the MP4 (`scenes.js`, `render.html`).
