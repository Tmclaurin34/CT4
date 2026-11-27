-- One store per account + claim_info. Run with 20261128180000 in one rolled-back transaction.
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';  -- has clicktide-test active
  other uuid := gen_random_uuid();
  c1 uuid; r jsonb; i jsonb;
begin
  insert into platform_connections (id, user_id, platform, shop_domain, is_active, access_token, merchant_id, merchant_name)
  values (gen_random_uuid(), null, 'shopify', 'second-dev.myshopify.com', true, 'tok2', '999111222', 'Second') returning id into c1;
  insert into shopify_install_claims (token_hash, connection_id, shop_domain) values ('h1', c1, 'second-dev.myshopify.com');

  -- 1. info: valid claim, no owner yet
  i := clicktide_shopify_claim_info('h1');
  if (i->>'ok')::boolean is not true or i->>'shop_domain' <> 'second-dev.myshopify.com' or i->>'owner' is not null then raise exception 'FAIL 1: %', i; end if;
  -- 2. an account that already has another store is refused, claim NOT consumed
  r := clicktide_shopify_claim('h1', u);
  if r->>'error' is distinct from 'other_store' or r->>'other_shop' <> 'clicktide-test.myshopify.com' then raise exception 'FAIL 2: %', r; end if;
  if not exists (select 1 from shopify_install_claims where token_hash = 'h1' and claimed_at is null) then raise exception 'FAIL 2b: claim consumed'; end if;
  -- 3. a fresh account can claim it
  insert into auth.users(id, email, aud, role) values (other, 'one-store-test@example.test', 'authenticated', 'authenticated');
  r := clicktide_shopify_claim('h1', other);
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 3: %', r; end if;
  -- 4. info for clicktide-test's store via a new unclaimed row: owner = u (reinstall path)
  insert into platform_connections (id, user_id, platform, shop_domain, is_active, access_token, merchant_id)
  values (gen_random_uuid(), null, 'shopify', 'clicktide-test.myshopify.com', false, '', '81761337561') returning id into c1;
  insert into shopify_install_claims (token_hash, connection_id, shop_domain) values ('h2', c1, 'clicktide-test.myshopify.com');
  i := clicktide_shopify_claim_info('h2');
  if (i->>'owner')::uuid is distinct from u then raise exception 'FAIL 4: %', i; end if;
  -- 5. unknown claim
  if (clicktide_shopify_claim_info('nope')->>'ok')::boolean is not false then raise exception 'FAIL 5'; end if;
  raise exception 'ALL ONE-STORE TESTS PASSED';
end $t$;
