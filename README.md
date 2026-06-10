# Supabase SQL Setup

This workspace is ready to connect to a Supabase Postgres database.

## 1. Add credentials

Copy `.env.example` to `.env`, then replace `SUPABASE_DB_URL` with the database URI from your Supabase dashboard:

Project Settings -> Database -> Connection string -> URI

Use the Postgres/database password, not the API anon key.

## 2. Install the Python driver

```sh
python3 -m pip install -r requirements.txt
```

## 3. Test the connection

```sh
python3 scripts/check_supabase.py
```

If it works, the script prints the connected database, user, schema, and server.

## Stripe checkout

The app uses Stripe Checkout for the Local, Growth, and Scale plans. The public
price IDs can live in the HTML, but the Stripe secret key must stay server-side.

1. Add the Stripe database fields:

```sh
.venv/bin/python scripts/apply_sql.py supabase_stripe_setup.sql
```

2. In Supabase, add Edge Function secrets:

```sh
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set LOCAL_PRICE_ID=price_xxx
supabase secrets set GROWTH_PRICE_ID=price_xxx
supabase secrets set SCALE_PRICE_ID=price_xxx
```

3. Deploy the checkout function:

```sh
supabase functions deploy create-checkout-session
```

The function source is in `supabase/functions/create-checkout-session/index.ts`.

4. Deploy the Stripe webhook function with JWT verification turned off:

```sh
supabase functions deploy stripe-webhook --no-verify-jwt
```

The function source is in `supabase/functions/stripe-webhook/index.ts`.

5. In Stripe, create a webhook endpoint that points to:

```text
https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/stripe-webhook
```

Send these events:

```text
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
```

6. Copy the webhook signing secret from Stripe and add it to Supabase Edge
Function secrets:

```sh
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

If you use a restricted Stripe key, make sure it can read subscriptions in
addition to creating Checkout Sessions.
