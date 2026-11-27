-- Shopify public-app tests (compliance redaction, tenant isolation, billing guard,
-- install claim). Always rolled back. Run: supabase/tests/run_shopify_tests.sh
do $$
declare
  b1 uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  b2 uuid;
  pass int := 0; fail int := 0; msgs text := '';
  c_ann bigint; c_bo bigint; c_mix bigint; c_other bigint; c_only bigint; conn uuid; n int; j jsonb; st text; pl text;
begin
  select user_id into b2 from clicktide where user_id is not null and user_id <> b1 order by id limit 1;
  insert into platform_connections(user_id, platform, merchant_id, shop_domain, access_token, is_active)
    values (b1, 'shopify', 'test-shop-1', 'ct-test-shop.myshopify.com', 'tok', true);
  insert into customers(user_id, name, email, phone, visits, total_spent, status) values (b1, 'T Ann', 'ann-t@example.com', '+13475550101', 1, 10, 'active') returning id into c_ann;
  insert into customers(user_id, name, email, phone, visits, total_spent, status) values (b1, 'T Bo', 'bo-t@example.com', '+13476660102', 1, 10, 'active') returning id into c_bo;
  insert into customers(user_id, name, email, visits, total_spent, status) values (b1, 'T Mix', 'mix-t@example.com', 2, 20, 'active') returning id into c_mix;
  insert into customers(user_id, name, email, visits, total_spent, status) values (b1, 'T Only', 'only-t@example.com', 1, 5, 'active') returning id into c_only;
  -- same shopper at a DIFFERENT business that is not connected to this shop
  insert into customers(user_id, name, email, visits, total_spent, status) values (b2, 'T Ann elsewhere', 'ann-t@example.com', 1, 10, 'active') returning id into c_other;
  perform clicktide_record_visit(b1, c_ann, now() - interval '10 days', 10, 'shopify', 'ord-1');
  perform clicktide_record_visit(b1, c_bo, now() - interval '9 days', 10, 'shopify', 'ord-2');
  perform clicktide_record_visit(b1, c_mix, now() - interval '20 days', 10, 'shopify', 'ord-3');
  perform clicktide_record_visit(b1, c_mix, now() - interval '5 days', 10, 'square', 'sq-1');
  perform clicktide_record_visit(b1, c_only, now() - interval '3 days', 5, 'shopify', 'ord-4');
  insert into shipments(user_id, customer_id, customer_name, customer_email, address, status) values (b1, c_ann, 'T Ann', 'ann-t@example.com', '{"line1":"1 Main"}', 'delivered');

  -- 1 customers/redact by email: Ann gone with her ledger; gift record kept but anonymised
  j := clicktide_shopify_redact_customer('CT-TEST-SHOP.myshopify.com', 'Ann-T@example.com', null, '{}');
  select count(*) into n from customers where id = c_ann;
  if n = 0 and (j->>'customers_deleted')::int = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [ann not deleted '||j::text||']'; end if;
  select count(*) into n from pos_transactions_seen where customer_id = c_ann;
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [ann ledger left]'; end if;
  select count(*) into n from shipments where user_id = b1 and customer_name = 'Redacted' and customer_email is null and address is null;
  if n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [shipment not anonymised]'; end if;
  -- 2 tenant isolation: the other business's Ann is untouched
  select count(*) into n from customers where id = c_other;
  if n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [other business customer deleted!]'; end if;
  -- 3 redact by phone (different formatting)
  j := clicktide_shopify_redact_customer('ct-test-shop.myshopify.com', '', '(347) 666-0102', '{}');
  select count(*) into n from customers where id = c_bo;
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [bo phone match failed]'; end if;
  -- 4 unknown shop: no-op
  j := clicktide_shopify_redact_customer('nobody.myshopify.com', 'only-t@example.com', null, '{}');
  if (j->>'customers_deleted')::int = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [unknown shop deleted]'; end if;
  -- 5 data_request finds the shopper
  j := clicktide_shopify_customer_data('ct-test-shop.myshopify.com', 'only-t@example.com', null);
  if jsonb_array_length(j) = 1 and j->0->'shopify_orders' = '["ord-4"]'::jsonb then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [data_request '||j::text||']'; end if;

  -- 6 billing: Shopify subscription sets the same entitlement Stripe does
  update clicktide set billing_provider = null, stripe_subscription_id = null, stripe_subscription_status = null where user_id = b1;
  j := clicktide_shopify_apply_entitlement('ct-test-shop.myshopify.com', 'Growth', 'trialing', now() + interval '30 days', 'gid://shopify/AppSubscription/1', 'ACTIVE');
  select plan, stripe_subscription_status into pl, st from clicktide where user_id = b1;
  if pl = 'Growth' and st = 'trialing' and (j->>'applied')::int = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [entitlement '||coalesce(pl,'-')||'/'||coalesce(st,'-')||']'; end if;
  -- 7 a service write that isn't the Shopify path can't change a Shopify-billed entitlement
  perform set_config('clicktide.billing_writer', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update clicktide set stripe_subscription_status = 'canceled', plan = 'Local' where user_id = b1;
  select plan, stripe_subscription_status into pl, st from clicktide where user_id = b1;
  if pl = 'Growth' and st = 'trialing' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [stripe write overrode shopify]'; end if;
  -- 8 a browser (non-staff signed-in user) can't set the billing provider
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  update clicktide set billing_provider = 'stripe', shopify_subscription_status = 'X' where user_id = b1;
  perform set_config('request.jwt.claims', '', true);
  select billing_provider into st from clicktide where user_id = b1;
  if st = 'shopify' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [browser changed billing_provider]'; end if;
  -- 9 a business paying through Stripe is never overridden
  update clicktide set billing_provider = null, stripe_subscription_id = 'sub_x', stripe_subscription_status = 'active', plan = 'Scale' where user_id = b2;
  insert into platform_connections(user_id, platform, merchant_id, shop_domain, access_token, is_active) values (b2, 'shopify', 'test-shop-2', 'ct-test-shop2.myshopify.com', 'tok', true);
  j := clicktide_shopify_apply_entitlement('ct-test-shop2.myshopify.com', 'Local', 'canceled', null, 'gid://x', 'CANCELLED');
  select plan, stripe_subscription_status into pl, st from clicktide where user_id = b2;
  if pl = 'Scale' and st = 'active' and (j->>'stripe_conflicts')::int = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [stripe business overridden]'; end if;

  -- 10 shop/redact: Shopify-only customer deleted, mixed customer kept minus Shopify rows, connection gone, billing ended
  j := clicktide_shopify_redact_shop('ct-test-shop.myshopify.com');
  select count(*) into n from customers where id = c_only;
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [shopify-only customer kept '||j::text||']'; end if;
  select count(*) into n from customers where id = c_mix;
  if n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [mixed customer deleted]'; end if;
  select count(*) into n from pos_transactions_seen where customer_id = c_mix and source = 'shopify';
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [mixed shopify rows left]'; end if;
  select count(*) into n from platform_connections where shop_domain = 'ct-test-shop.myshopify.com';
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [connection kept]'; end if;
  select stripe_subscription_status into st from clicktide where user_id = b1;
  if st = 'canceled' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [billing not ended]'; end if;

  -- 11 install claim: single use, attaches to the signed-in business
  insert into platform_connections(user_id, platform, merchant_id, shop_domain, access_token, is_active) values (null, 'shopify', 'test-shop-3', 'ct-test-shop3.myshopify.com', 'tok3', true) returning id into conn;
  insert into shopify_install_claims(token_hash, connection_id, shop_domain) values ('hash-1', conn, 'ct-test-shop3.myshopify.com');
  j := clicktide_shopify_claim('hash-1', b1);
  select count(*) into n from platform_connections where id = conn and user_id = b1;
  if (j->>'ok')::boolean and n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [claim '||j::text||']'; end if;
  j := clicktide_shopify_claim('hash-1', b2);
  if not (j->>'ok')::boolean then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [claim reused]'; end if;

  -- 12 browsers can't call the server-only functions
  select count(*) into n from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
     and routine_name in ('clicktide_purge_customers','clicktide_shopify_redact_customer','clicktide_shopify_redact_shop','clicktide_shopify_customer_data','clicktide_shopify_apply_entitlement','clicktide_shopify_claim');
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [functions exposed]'; end if;

  raise exception 'SHOPIFY TESTS: % passed, % failed.%', pass, fail, msgs;
end $$;
