-- Website-first (Stripe) business that connects Shopify. Run in one transaction with
-- 20261128170000_shopify_switch_from_stripe.sql; ends with raise exception (nothing kept).
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';  -- Clicktide Test Business (clicktide-test store connected)
  shop text := 'clicktide-test.myshopify.com';
  r jsonb; b record;
begin
  perform set_config('clicktide.billing_writer', 'shopify', true);
  update clicktide set billing_provider = 'stripe', stripe_subscription_id = 'sub_TESTswitch',
         stripe_subscription_status = 'active', plan = 'Growth' where user_id = u;
  perform set_config('clicktide.billing_writer', '', true);

  -- 1. Shopify plan pending (merchant hasn't approved): Stripe payer untouched
  r := clicktide_shopify_apply_entitlement(shop, 'Local', 'incomplete', now() + interval '30 days', 'gid://shopify/AppSubscription/1', 'PENDING');
  select * into b from clicktide where user_id = u;
  if b.billing_provider <> 'stripe' or b.plan <> 'Growth' or b.stripe_subscription_status <> 'active' or (r->>'stripe_conflicts')::int <> 1
     or jsonb_array_length(r->'stripe_cancel') <> 0 then raise exception 'FAIL 1: % %', r, row_to_json(b); end if;

  -- 2. no plan at all: untouched
  r := clicktide_shopify_apply_entitlement(shop, null, 'canceled', null, null, 'NONE');
  select * into b from clicktide where user_id = u;
  if b.billing_provider <> 'stripe' or b.stripe_subscription_status <> 'active' then raise exception 'FAIL 2: % %', r, row_to_json(b); end if;

  -- 3. live Shopify plan: switches to Shopify and asks to cancel the Stripe subscription
  r := clicktide_shopify_apply_entitlement(shop, 'Local', 'trialing', now() + interval '30 days', 'gid://shopify/AppSubscription/1', 'ACTIVE');
  select * into b from clicktide where user_id = u;
  if b.billing_provider <> 'shopify' or b.plan <> 'Local' or b.stripe_subscription_status <> 'trialing'
     or r->'stripe_cancel'->0->>'stripe_subscription_id' <> 'sub_TESTswitch' then raise exception 'FAIL 3: % %', r, row_to_json(b); end if;

  if not exists (select 1 from shopify_stripe_switch where stripe_subscription_id = 'sub_TESTswitch' and user_id = u and done_at is null)
    then raise exception 'FAIL 3b: cancel not queued'; end if;

  -- 4. a late Stripe webhook (service role, no shopify writer) can't flip it back
  perform set_config('clicktide.billing_writer', '', true);  -- a separate request in production
  perform set_config('request.jwt.claim.role', 'service_role', true);
  update clicktide set stripe_subscription_status = 'canceled', billing_provider = 'stripe', plan = 'Growth' where user_id = u;
  select * into b from clicktide where user_id = u;
  if b.billing_provider <> 'shopify' or b.plan <> 'Local' or b.stripe_subscription_status <> 'trialing' then raise exception 'FAIL 4: %', row_to_json(b); end if;

  -- 5. re-run (nightly): already Shopify-billed, no second cancel request
  r := clicktide_shopify_apply_entitlement(shop, 'Local', 'active', now() + interval '30 days', 'gid://shopify/AppSubscription/1', 'ACTIVE');
  if jsonb_array_length(r->'stripe_cancel') <> 0 or (r->>'applied')::int <> 1 then raise exception 'FAIL 5: %', r; end if;

  raise exception 'ALL SWITCH TESTS PASSED';
end $t$;
