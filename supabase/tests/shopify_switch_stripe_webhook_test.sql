-- After a Stripe payer switches to Shopify billing, the later Stripe events for its old
-- subscription (updated with cancel_at_period_end, then deleted) must not throw (stripe-webhook
-- would 500 and Stripe would retry forever) and must not touch plan/status/billing_provider.
-- Run with 20261128170000_shopify_switch_from_stripe.sql in one rolled-back transaction.
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  shop text := 'clicktide-test.myshopify.com';
  r jsonb; r2 jsonb; b record;
begin
  perform set_config('clicktide.billing_writer', 'shopify', true);
  update clicktide set billing_provider = 'stripe', stripe_subscription_id = 'sub_TESTswitch',
         stripe_subscription_status = 'active', plan = 'Growth' where user_id = u;
  perform clicktide_shopify_apply_entitlement(shop, 'Local', 'trialing', now() + interval '30 days', 'gid://shopify/AppSubscription/1', 'ACTIVE');
  perform set_config('clicktide.billing_writer', '', true);   -- the webhook is a separate request
  perform set_config('request.jwt.claim.role', 'service_role', true);

  r := clicktide_billing_apply_subscription('evt_TEST_upd', now(), 'sub_TESTswitch', 'cus_TESTx', u, 'active', 'price_x', 'Growth', now() + interval '10 days', null, null);
  r2 := clicktide_billing_apply_subscription('evt_TEST_del', now(), 'sub_TESTswitch', 'cus_TESTx', null, 'canceled', null, null, now(), null, null);
  select * into b from clicktide where user_id = u;
  if b.billing_provider <> 'shopify' or b.plan <> 'Local' or b.stripe_subscription_status <> 'trialing' then
    raise exception 'FAIL: row changed: % / % / %', row_to_json(b), r, r2; end if;
  raise exception 'WEBHOOK SWITCH TEST PASSED updated=% deleted=%', r, r2;
end $t$;
