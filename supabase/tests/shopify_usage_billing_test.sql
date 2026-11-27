-- Run inside a transaction with the migration; ends with raise exception so nothing is kept.
do $t$
declare
  shop_user uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a'; -- Clicktide Test Business (Shopify test store connected)
  plain uuid := gen_random_uuid();
  r jsonb; r2 jsonb; r3 jsonb; n int; q record; bal numeric;
begin
  -- 1. a business that is NOT Shopify-billed: an empty wallet still refuses a postcard
  insert into auth.users(id, email, aud, role) values (plain, 'usage-plain@example.test', 'authenticated', 'authenticated');
  insert into clicktide(user_id, business_name, stripe_subscription_status) values (plain, 'Plain Co', 'active');
  r := clicktide_wallet_apply(plain, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-plain-1');
  if r->>'reason' is distinct from 'insufficient_funds' then raise exception 'FAIL 1: plain business not refused: %', r; end if;

  -- 2. make the test business Shopify-billed (same writer flag the Shopify entitlement uses)
  perform set_config('clicktide.billing_writer', 'shopify', true);
  update clicktide set billing_provider = 'shopify', stripe_subscription_status = 'active' where user_id = shop_user;
  if not clicktide_shopify_usage_billed(shop_user) then raise exception 'FAIL 2a: not detected as Shopify-billed'; end if;
  bal := clicktide_wallet_balance(shop_user);
  r := clicktide_wallet_apply(shop_user, -1.5, 'postcard_debit', 'Postcard: test', 'c1', 'k-shop-1');
  if (r->>'ok')::boolean is not true or (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 2b: shopify debit: %', r; end if;
  -- 3. replay is a duplicate, no second row
  r2 := clicktide_wallet_apply(shop_user, -1.5, 'postcard_debit', 'Postcard: test', 'c1', 'k-shop-1');
  if (r2->>'duplicate')::boolean is not true then raise exception 'FAIL 3: replay not duplicate: %', r2; end if;
  -- 4. refund marked too; gift debit with cents
  r3 := clicktide_wallet_apply(shop_user, 1.5, 'postcard_refund', 'Refund', 'c1', 'k-shop-2');
  perform clicktide_wallet_apply(shop_user, -12.99, 'gift_debit', 'Gift', 'g1', 'k-shop-3');
  -- a non-usage kind (top-up) for this business is NOT shopify usage
  select count(*) into n from wallet where user_id = shop_user and idempotency_key in ('k-shop-1','k-shop-2','k-shop-3') and shopify_usage;
  if n <> 3 then raise exception 'FAIL 4: expected 3 usage rows, got %', n; end if;
  -- 5. queue lists them with the shop
  select count(*) into n from clicktide_shopify_usage_pending(100) p where p.user_id = shop_user and p.merchant_id = '81761337561';
  if n <> 3 then raise exception 'FAIL 5: queue has % rows', n; end if;
  -- 6. mark one reported
  select p.id into q from clicktide_shopify_usage_pending(100) p where p.user_id = shop_user order by p.id limit 1;
  perform clicktide_shopify_usage_mark(q.id, true, null);
  select count(*) into n from clicktide_shopify_usage_pending(100) p where p.user_id = shop_user;
  if n <> 2 then raise exception 'FAIL 6: after mark queue has %', n; end if;
  -- 7. failure marking keeps it queued with an error and attempt count
  select p.id into q from clicktide_shopify_usage_pending(100) p where p.user_id = shop_user order by p.id limit 1;
  perform clicktide_shopify_usage_mark(q.id, false, 'HTTP 503');
  select count(*) into n from wallet where id = q.id and shopify_usage_attempts = 1 and shopify_usage_error = 'HTTP 503' and shopify_usage_reported_at is null;
  if n <> 1 then raise exception 'FAIL 7: failure not recorded'; end if;
  -- 8. Shopify usage never touches the prepaid balance
  if clicktide_wallet_balance(shop_user) <> bal then raise exception 'FAIL 8: prepaid balance moved % -> %', bal, clicktide_wallet_balance(shop_user); end if;
  -- 9. a top-up-style kind for the Shopify business is still a normal (non-usage) row
  r := clicktide_wallet_apply(shop_user, -1, 'refund', 'Refund unused funds', 'x', 'k-shop-4');
  if (r->>'shopify_usage')::boolean is not false or clicktide_wallet_balance(shop_user) <> bal - 1 then raise exception 'FAIL 9: refund kind affected: %', r; end if;
  raise exception 'ALL USAGE BILLING TESTS PASSED (prepaid balance kept at %)', bal;
end $t$;
