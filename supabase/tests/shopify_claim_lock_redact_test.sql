-- Run with 20261128180000 (already live), 180200 and 180300 in one rolled-back transaction.
do $t$
declare
  su uuid := gen_random_uuid(); wu uuid := gen_random_uuid();
  c1 uuid; r jsonb; ids uuid[]; n int;
  shop text := 'redact-test.myshopify.com';
begin
  insert into auth.users(id, email, aud, role, raw_app_meta_data) values
    (su, 'redact-test@shopify-users.goclicktide.com', 'authenticated', 'authenticated', jsonb_build_object('shopify_shop', shop, 'signup', 'shopify')),
    (wu, 'web-owner@example.test', 'authenticated', 'authenticated', '{}'::jsonb);
  insert into clicktide(user_id, business_name, email) values (su, 'Redact Co', 'owner@redact.example'), (wu, 'Web Co', 'web@example.test');
  insert into customers(user_id, name, email) values (su, 'Shopper', 'shopper@example.test');
  insert into a2p_registrations(user_id, business_name) values (su, 'Redact Co LLC'), (wu, 'Web Co LLC');
  insert into support_chats(user_id, session_id, role, content) values (su, 's1', 'user', 'hello'), (wu, 's2', 'user', 'hi');
  insert into platform_connections (id, user_id, platform, shop_domain, is_active, access_token, merchant_id) values (gen_random_uuid(), null, 'shopify', shop, true, 't', '777') returning id into c1;
  insert into shopify_install_claims (token_hash, connection_id, shop_domain) values ('lockA', c1, shop);
  r := clicktide_shopify_claim('lockA', su);
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 1a: %', r; end if;
  insert into platform_connections (id, user_id, platform, shop_domain, is_active, access_token, merchant_id) values (gen_random_uuid(), null, 'shopify', shop, false, 't2', '777') returning id into c1;
  insert into shopify_install_claims (token_hash, connection_id, shop_domain) values ('lockB', c1, shop);
  r := clicktide_shopify_claim('lockB', wu);
  if r->>'error' is distinct from 'already_claimed' then raise exception 'FAIL 1b: %', r; end if;
  ids := clicktide_shopify_redact_store_accounts(shop);
  if cardinality(ids) <> 0 then raise exception 'FAIL 2: erased a live store'; end if;
  update platform_connections set is_active = false where shop_domain = shop;
  ids := clicktide_shopify_redact_store_accounts(shop);
  if ids <> array[su] then raise exception 'FAIL 3a: %', ids; end if;
  select count(*) into n from clicktide where user_id = su; if n <> 0 then raise exception 'FAIL 3b: profile kept'; end if;
  select count(*) into n from customers where user_id = su; if n <> 0 then raise exception 'FAIL 3c: customers kept'; end if;
  select count(*) into n from clicktide where user_id = wu; if n <> 1 then raise exception 'FAIL 3d: website account touched'; end if;
  select count(*) into n from a2p_registrations where user_id = su; if n <> 0 then raise exception 'FAIL 3e: a2p kept'; end if;
  select count(*) into n from support_chats where user_id = su; if n <> 0 then raise exception 'FAIL 3f: chats kept'; end if;
  select count(*) into n from a2p_registrations where user_id = wu; if n <> 1 then raise exception 'FAIL 3g: website a2p touched'; end if;
  select count(*) into n from support_chats where user_id = wu; if n <> 1 then raise exception 'FAIL 3h: website chats touched'; end if;
  raise exception 'ALL CLAIM-LOCK / REDACT TESTS PASSED';
end $t$;
