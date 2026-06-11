# Gift pricing — source of truth

Three different numbers exist around gifts; they are intentional, not contradictory:

1. **`gift_catalog.estimated_cost` (what the business's wallet is charged)** — synced
   from Printify's PRODUCTION cost by `sync-printify-catalog`. Live floor as of
   2026-06-11: Branded Stickers **$1.58** → marketing claim "gifts from $2" (rounded UP,
   never under-quoted). Mug $6.44 · Notebook $8.29 · up to Tumbler $24.50.
2. **`TARGETS[].price` in `printify-create-starter-products` (cents)** — the RETAIL
   price set on the Printify product listing. Not what wallets are charged; exists
   because Printify requires a sale price on every product.
3. **"Est. $" values in the site's gift gallery** — estimated retail VALUE shown to
   businesses for perceived-value framing. Display only.

Fresh-deploy order: run `printify-create-starter-products` (cron-key gated, needs
logo b64) → run `sync-printify-catalog` (x-clicktide-sync-key) → `gift_catalog`
fills with real production costs and mockups. Marketing copy rule: quote wallet
costs (#1) only, rounded up to whole dollars.
