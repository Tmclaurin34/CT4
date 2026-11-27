-- SSO codes. Run with 20261128180200 in one rolled-back transaction.
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';  -- active clicktide-test connection
  shop text := 'clicktide-test.myshopify.com';
  code text; r jsonb; staff_had boolean;
begin
  select exists(select 1 from clicktide_staff where user_id = u and coalesce(is_active, true)) into staff_had;
  if staff_had then
    -- 1. staff accounts never get a code
    if clicktide_shopify_sso_mint(u, shop) is not null then raise exception 'FAIL 1: staff got a code'; end if;
    delete from clicktide_staff where user_id = u;   -- rolled back
  end if;
  -- 1b. make it staff (rolled back): no code
  insert into clicktide_staff(user_id, role, is_active) values (u, 'support', true) on conflict (user_id) do update set is_active = true;
  if clicktide_shopify_sso_mint(u, shop) is not null then raise exception 'FAIL 1b: staff got a code'; end if;
  delete from clicktide_staff where user_id = u;
  -- 2. wrong shop: no code
  if clicktide_shopify_sso_mint(u, 'other.myshopify.com') is not null then raise exception 'FAIL 2'; end if;
  -- 3. mint + take once
  code := clicktide_shopify_sso_mint(u, shop);
  if code !~ '^[0-9a-f]{64}$' then raise exception 'FAIL 3a: %', code; end if;
  if exists (select 1 from shopify_sso_codes where code_hash = code) then raise exception 'FAIL 3b: stored in clear'; end if;
  r := clicktide_shopify_sso_take(code);
  if (r->>'ok')::boolean is not true or (r->>'user_id')::uuid <> u or r->>'shop' <> shop then raise exception 'FAIL 3c: %', r; end if;
  -- 4. replay refused
  if (clicktide_shopify_sso_take(code)->>'ok')::boolean then raise exception 'FAIL 4: replay'; end if;
  -- 5. expired refused
  code := clicktide_shopify_sso_mint(u, shop);
  update shopify_sso_codes set expires_at = now() - interval '1 second';
  if (clicktide_shopify_sso_take(code)->>'ok')::boolean then raise exception 'FAIL 5: expired'; end if;
  -- 6. connection deactivated between mint and take: refused
  code := clicktide_shopify_sso_mint(u, shop);
  update platform_connections set is_active = false where user_id = u and platform = 'shopify';
  if (clicktide_shopify_sso_take(code)->>'ok')::boolean then raise exception 'FAIL 6: inactive store'; end if;
  -- 7. junk
  if (clicktide_shopify_sso_take('xyz')->>'ok')::boolean then raise exception 'FAIL 7'; end if;
  raise exception 'ALL SSO CODE TESTS PASSED (staff case tested: %)', staff_had;
end $t$;
