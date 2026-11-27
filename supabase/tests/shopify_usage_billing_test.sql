-- Shopify usage billing v3. Run inside one transaction with the migration; ends with raise
-- exception so nothing is kept. U = the Clicktide Test Business (its Shopify test store is connected).
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  plain uuid := gen_random_uuid();
  shop text := 'clicktide-test.myshopify.com';
  r jsonb; n int; bal numeric; q record; v jsonb; used0 numeric; used1 numeric; cs timestamptz;
begin
  -- 1. a business that is NOT Shopify-billed: unchanged (empty wallet refuses, no Shopify flag)
  insert into auth.users(id, email, aud, role) values (plain, 'usage-plain@example.test', 'authenticated', 'authenticated');
  insert into clicktide(user_id, business_name, stripe_subscription_status) values (plain, 'Plain Co', 'active');
  r := clicktide_wallet_apply(plain, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-plain-1');
  if r->>'reason' is distinct from 'insufficient_funds' or r ? 'shopify_usage_refused' then raise exception 'FAIL 1: %', r; end if;

  -- Shopify billing for U, set the way the Shopify entitlement does
  perform set_config('clicktide.billing_writer', 'shopify', true);
  update clicktide set billing_provider = 'shopify', shopify_shop_domain = shop, stripe_subscription_status = 'active' where user_id = u;
  perform set_config('clicktide.billing_writer', '', true);
  bal := clicktide_wallet_balance(u);
  if bal > 0 then perform clicktide_wallet_apply(u, -bal, 'refund', 'test drain', 'drain', 'k-drain'); end if;
  if clicktide_wallet_balance(u) <> 0 then raise exception 'setup: balance not drained'; end if;

  -- 2. no limits row yet: refused (fail closed), flagged as a Shopify refusal
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-2');
  if r->>'reason' is distinct from 'insufficient_funds' or (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 2: %', r; end if;
  -- 3. development store / test charge: refused
  perform clicktide_shopify_usage_sync(shop, 'Local', now() + interval '20 days', true, false);
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-3');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 3: %', r; end if;
  -- 4. unknown cycle: refused
  perform clicktide_shopify_usage_sync(shop, 'Local', null, false, false);
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-4');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 4: %', r; end if;
  -- 5. stale sync (> 3h): refused
  perform clicktide_shopify_usage_sync(shop, 'Local', now() + interval '20 days', false, false);
  update shopify_usage_limits set synced_at = now() - interval '4 hours' where user_id = u;
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-5');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 5: %', r; end if;
  -- 5b. plan in free trial: refused (limit 0 until trial billing is confirmed)
  perform clicktide_shopify_usage_sync(shop, 'Local', now() + interval '20 days', false, true);
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-5b');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 5b: %', r; end if;

  -- real, fresh, paid Local: limit 150
  perform clicktide_shopify_usage_sync(shop, 'Local', now() + interval '20 days', false, false);
  -- 5c. a debit without an idempotency key can't be Shopify usage (its refund couldn't find it)
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', null);
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 5c: %', r; end if;

  -- 6. allowed; the row stores the shop it bills; replay is a duplicate
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-6');
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 6a: %', r; end if;
  select count(*) into n from wallet where idempotency_key = 'k-6' and shopify_shop_domain = shop and shopify_merchant_id ~ '^[0-9]+$';
  if n <> 1 then raise exception 'FAIL 6b: shop not stored on the row'; end if;
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-6');
  if (r->>'duplicate')::boolean is not true then raise exception 'FAIL 6c replay: %', r; end if;

  -- 7. cap boundary: used 1.50; 148.50 lands exactly on 150 (allowed); one cent more is refused
  r := clicktide_wallet_apply(u, -148.5, 'gift_debit', 'Gift', 'g1', 'k-7a');
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 7a: %', r; end if;
  r := clicktide_wallet_apply(u, -0.01, 'gift_debit', 'Gift', 'g2', 'k-7b');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 7b: %', r; end if;
  -- 8. prepaid balance untouched by Shopify usage
  if clicktide_wallet_balance(u) <> 0 then raise exception 'FAIL 8: balance %', clicktide_wallet_balance(u); end if;

  -- 9a. a refund follows its own debit (key '<debit>:refund'): Shopify usage, frees the cap
  r := clicktide_wallet_apply(u, 148.5, 'gift_refund', 'Refund', 'g1', 'k-7a:refund');
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 9a: %', r; end if;
  -- 9b. same REFERENCE but not that debit's key: never Shopify usage (re-credits prepaid)
  r := clicktide_wallet_apply(u, 2, 'gift_refund', 'Refund', 'g1', 'k-zz:refund');
  if (r->>'shopify_usage')::boolean is not false or clicktide_wallet_balance(u) <> 2 then raise exception 'FAIL 9b: %', r; end if;
  -- 9c. B1 repro: prepaid covers -> prepaid debit (reference 'c1', shared with Shopify debit k-6)
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c1', 'k-pp');
  if (r->>'shopify_usage')::boolean is not false or clicktide_wallet_balance(u) <> 0.5 then raise exception 'FAIL 9c: %', r; end if;
  -- 9d. ...and its refund re-credits prepaid (not marked Shopify, not netted against k-6)
  r := clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', 'c1', 'k-pp:refund');
  if (r->>'shopify_usage')::boolean is not false or clicktide_wallet_balance(u) <> 2 then raise exception 'FAIL 9d: %', r; end if;
  -- 9e. null-reference variant
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', null, 'k-ppn');   -- prepaid (2 -> 0.5)
  if (r->>'shopify_usage')::boolean is not false then raise exception 'FAIL 9e1: %', r; end if;
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', null, 'k-sn');    -- 0.5 < 1.5 -> Shopify
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 9e2: %', r; end if;
  r := clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', null, 'k-ppn:refund');
  if (r->>'shopify_usage')::boolean is not false or clicktide_wallet_balance(u) <> 2 then raise exception 'FAIL 9e3: %', r; end if;
  perform clicktide_wallet_apply(u, -2, 'refund', 'test drain', 'drain', 'k-drain2');

  -- 10a. netting pairs ONLY by the debit's own key: k-7a + k-7a:refund cancel; k-6 and k-sn don't
  n := clicktide_shopify_usage_net();
  if n <> 1 then raise exception 'FAIL 10a: netted %', n; end if;
  select count(*) into n from wallet where user_id = u and idempotency_key in ('k-6', 'k-sn') and shopify_usage_cancelled_at is not null;
  if n <> 0 then raise exception 'FAIL 10a2: an unrelated row was netted'; end if;
  -- 10b. a claimed (in-flight) debit is never netted
  perform clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c2', 'k-c');
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.user_id = u;   -- claims k-6, k-sn, k-c
  if n <> 3 then raise exception 'FAIL 10b1: claimed %', n; end if;
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.user_id = u;   -- a second runner gets nothing
  if n <> 0 then raise exception 'FAIL 10b2: claimed twice'; end if;
  perform clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', 'c2', 'k-c:refund');
  n := clicktide_shopify_usage_net();
  if n <> 0 then raise exception 'FAIL 10b3: netted an in-flight debit'; end if;
  select id into q from wallet where idempotency_key = 'k-c';
  perform clicktide_shopify_usage_mark(q.id, true, null);
  select count(*) into n from wallet where idempotency_key = 'k-c:refund' and shopify_usage_cancelled_at is null and shopify_usage_reported_at is null;
  if n <> 1 then raise exception 'FAIL 10b4: refund of a reported debit not queued'; end if;
  -- 10c. race: netting cancelled a pair, then the debit's in-flight send comes back 2xx:
  --      the debit is un-cancelled (reported) and its refund re-queued, so it gets sent
  perform clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c3', 'k-d');
  perform clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', 'c3', 'k-d:refund');
  n := clicktide_shopify_usage_net();
  if n <> 1 then raise exception 'FAIL 10c1: netted %', n; end if;
  select id into q from wallet where idempotency_key = 'k-d';
  perform clicktide_shopify_usage_mark(q.id, true, null);
  select count(*) into n from wallet where idempotency_key = 'k-d' and shopify_usage_reported_at is not null and shopify_usage_cancelled_at is null;
  if n <> 1 then raise exception 'FAIL 10c2: debit not restored'; end if;
  select count(*) into n from wallet where idempotency_key = 'k-d:refund' and shopify_usage_cancelled_at is null and shopify_usage_reported_at is null
     and (shopify_usage_next_at is null or shopify_usage_next_at <= now());
  if n <> 1 then raise exception 'FAIL 10c3: partner refund not re-queued'; end if;

  -- 10d. B2 / R1: a claimed debit whose send got a 2xx but whose mark never landed. After the
  --      claim expires it must still never be netted with a later refund (Shopify billed it).
  perform clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c6', 'k-r1');
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.user_id = u and p.transaction_type = 'postcard_debit';
  if n < 1 then raise exception 'FAIL 10d1: k-r1 not claimed'; end if;
  update wallet set shopify_usage_next_at = now() - interval '1 second' where idempotency_key = 'k-r1';  -- claim expired, mark lost
  perform clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', 'c6', 'k-r1:refund');
  n := clicktide_shopify_usage_net();
  if n <> 0 then raise exception 'FAIL 10d2: netted a claimed debit (R1)'; end if;
  -- 10e. its refund isn't sent while the debit is unreported; it is once the debit is reported
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.user_id = u and p.transaction_type = 'postcard_refund'
     and p.id = (select id from wallet where idempotency_key = 'k-r1:refund');
  if n <> 0 then raise exception 'FAIL 10e1: refund sent before its debit'; end if;
  select id into q from wallet where idempotency_key = 'k-r1';
  perform clicktide_shopify_usage_mark(q.id, true, null);
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.id = (select id from wallet where idempotency_key = 'k-r1:refund');
  if n <> 1 then raise exception 'FAIL 10e2: refund not sent after its debit was reported'; end if;
  -- (k-r1 + k-r1:refund are both billed, net 0, so the cycle totals below are unchanged)

  -- 11. failure backs off; only a success sets reported_at
  select id into q from wallet where idempotency_key = 'k-sn';
  perform clicktide_shopify_usage_mark(q.id, false, 'HTTP 503');
  select count(*) into n from wallet where id = q.id and shopify_usage_reported_at is null and shopify_usage_next_at > now() and shopify_usage_error like 'HTTP 503%';
  if n <> 1 then raise exception 'FAIL 11a: backoff not set'; end if;
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.id = q.id;
  if n <> 0 then raise exception 'FAIL 11b: backed-off row still due'; end if;

  -- 12. overdue: an unreported row older than 1h shows up for ops
  update wallet set created_at = now() - interval '2 hours' where idempotency_key = 'k-sn';
  v := clicktide_shopify_usage_overdue();
  if (v->>'rows')::int < 1 then raise exception 'FAIL 12: %', v; end if;

  -- 13. owner sees this cycle (own row): debits k-6, k-sn, k-c, k-d, k-r1 = 7.50 less refunds k-c,
  --     k-d, k-r1 = 4.50 -> 3.00; reported so far: debits k-c, k-d, k-r1 = 4.50 (no refund reported yet)
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v := clicktide_shopify_usage_this_cycle();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if (v->>'billed')::numeric <> 3.00 or (v->>'reported')::numeric <> 4.50 or (v->>'limit')::numeric <> 150 then raise exception 'FAIL 13: %', v; end if;

  -- 14. M2: refunding a PREVIOUS cycle's debit doesn't free this cycle's cap
  perform clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c4', 'k-old');
  select cycle_start into cs from shopify_usage_limits where user_id = u;
  update wallet set created_at = cs - interval '1 day' where idempotency_key = 'k-old';
  used0 := clicktide_shopify_usage_cycle_used(u, cs);
  r := clicktide_wallet_apply(u, 1.5, 'postcard_refund', 'Refund', 'c4', 'k-old:refund');
  used1 := clicktide_shopify_usage_cycle_used(u, cs);
  if (r->>'shopify_usage')::boolean is not true or used1 <> used0 then raise exception 'FAIL 14: % -> % (%)', used0, used1, r; end if;

  -- 14b. refund_mismatch: the key points at a Shopify debit but the amount is larger, or the kind differs
  perform clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c7', 'k-m');
  r := clicktide_wallet_apply(u, 3, 'postcard_refund', 'Refund', 'c7', 'k-m:refund');
  if r->>'reason' is distinct from 'refund_mismatch' then raise exception 'FAIL 14b1: %', r; end if;
  r := clicktide_wallet_apply(u, 1.5, 'gift_refund', 'Refund', 'c7', 'k-m:refund');
  if r->>'reason' is distinct from 'refund_mismatch' then raise exception 'FAIL 14b2: %', r; end if;
  if clicktide_wallet_balance(u) <> 0 then raise exception 'FAIL 14b3: prepaid was credited'; end if;
  -- a partial gift refund is fine (gift meter counts dollars)
  perform clicktide_wallet_apply(u, -10, 'gift_debit', 'Gift', 'g9', 'k-g9');
  r := clicktide_wallet_apply(u, 4, 'gift_refund', 'Refund', 'g9', 'k-g9:refund');
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 14b4: %', r; end if;
  -- 14c. count meters need the exact unit price on the Shopify path
  r := clicktide_wallet_apply(u, -2, 'postcard_debit', 'Postcard', 'c8', 'k-up');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 14c1: %', r; end if;
  r := clicktide_wallet_apply(u, -0.10, 'sms_overage', 'Text', 's1', 'k-up2');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 14c2: %', r; end if;
  r := clicktide_wallet_apply(u, -0.05, 'sms_overage', 'Text', 's1', 'k-up3');
  if (r->>'shopify_usage')::boolean is not true then raise exception 'FAIL 14c3: %', r; end if;
  -- 14d. no new Shopify usage in the last hour of the cycle (an event after cycle end is PERIOD_CLOSED)
  update shopify_usage_limits set cycle_end = now() + interval '30 minutes' where user_id = u;
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c9', 'k-ce');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 14d: %', r; end if;
  update shopify_usage_limits set cycle_end = now() + interval '20 days' where user_id = u;

  -- 15. B5: a second active Shopify connection -> refused; billed shop != connection -> refused
  insert into platform_connections (id, user_id, platform, shop_domain, is_active, access_token, merchant_id)
  values (gen_random_uuid(), u, 'shopify', 'other-dev.myshopify.com', true, 'tok', '999000111');
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c5', 'k-15a');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 15a: %', r; end if;
  delete from platform_connections where merchant_id = '999000111';
  perform set_config('clicktide.billing_writer', 'shopify', true);
  update clicktide set shopify_shop_domain = 'other-dev.myshopify.com' where user_id = u;
  r := clicktide_wallet_apply(u, -1.5, 'postcard_debit', 'Postcard', 'c5', 'k-15b');
  if (r->>'shopify_usage_refused')::boolean is not true then raise exception 'FAIL 15b: %', r; end if;
  update clicktide set shopify_shop_domain = shop where user_id = u;
  perform set_config('clicktide.billing_writer', '', true);

  -- 16. M3: a non-ledger insert (service role / SQL) can't create Shopify usage
  insert into wallet (user_id, "desc", amount, transaction_type, status, shopify_usage, shopify_merchant_id)
  values (u, 'forged', 5, 'topup', 'posted', true, '123');
  select count(*) into n from wallet where user_id = u and "desc" = 'forged' and not shopify_usage and shopify_merchant_id is null;
  if n <> 1 then raise exception 'FAIL 16: forged usage row kept its flag'; end if;

  -- 17. shop/redact deletes the connection: unreported usage is still queued with its shop id
  delete from platform_connections where platform = 'shopify' and user_id = u;
  select count(*) into n from clicktide_shopify_usage_pending(500) p where p.user_id = u and p.merchant_id ~ '^[0-9]+$';
  if n < 1 then raise exception 'FAIL 17: usage lost after redact'; end if;

  -- 18. reporter lease: one holder at a time
  if not clicktide_shopify_usage_lease('A', 300) then raise exception 'FAIL 18a'; end if;
  if clicktide_shopify_usage_lease('B', 300) then raise exception 'FAIL 18b: second holder got the lease'; end if;
  perform clicktide_shopify_usage_release('A');
  if not clicktide_shopify_usage_lease('B', 300) then raise exception 'FAIL 18c'; end if;
  -- dead-man: U is Shopify-billed and no run has succeeded yet -> stale; a successful run clears it
  if (clicktide_shopify_usage_heartbeat()->>'stale')::boolean is not true then raise exception 'FAIL 18d: %', clicktide_shopify_usage_heartbeat(); end if;
  perform clicktide_shopify_usage_release('B', true);
  if (clicktide_shopify_usage_heartbeat()->>'stale')::boolean is not false then raise exception 'FAIL 18e: %', clicktide_shopify_usage_heartbeat(); end if;

  -- 19. grants: browsers can't call the server functions
  if has_function_privilege('authenticated', 'clicktide_shopify_usage_plan_limit(text, boolean)', 'execute')
     or has_function_privilege('anon', 'clicktide_shopify_usage_pending(integer)', 'execute')
     or has_function_privilege('authenticated', 'clicktide_shopify_usage_allowed(uuid, numeric)', 'execute')
     or has_function_privilege('anon', 'clicktide_shopify_usage_this_cycle()', 'execute')
     or not has_function_privilege('authenticated', 'clicktide_shopify_usage_this_cycle()', 'execute') then
    raise exception 'FAIL 19: grants';
  end if;

  raise exception 'ALL USAGE BILLING v3 TESTS PASSED (this cycle %)', v;
end $t$;
