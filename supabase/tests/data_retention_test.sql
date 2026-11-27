do $t$
declare
  biz uuid := gen_random_uuid(); live uuid := gen_random_uuid(); r jsonb; n int; c timestamptz;
begin
  insert into auth.users(id, email, aud, role) values (biz, 'ret-closed@example.test', 'authenticated', 'authenticated'), (live, 'ret-live@example.test', 'authenticated', 'authenticated');
  insert into clicktide(user_id, business_name, stripe_subscription_status) values (biz, 'Closed Co', 'canceled'), (live, 'Live Co', 'active');
  select data_closed_at into c from clicktide where user_id = biz;
  if c is null then raise exception 'FAIL: closed_at not set on insert'; end if;
  if (select data_closed_at from clicktide where user_id = live) is not null then raise exception 'FAIL: live has closed_at'; end if;
  -- client cannot clear it
  update clicktide set data_closed_at = null where user_id = biz;
  if (select data_closed_at from clicktide where user_id = biz) is null then raise exception 'FAIL: closed_at cleared by write'; end if;
  insert into customers(user_id, name, email) values (biz, 'Shopper A', 'a@example.test'), (live, 'Shopper B', 'b@example.test');
  insert into platform_connections(user_id, platform, merchant_id, access_token, is_active) values (biz, 'square', 'm1', 'tok', true);
  -- within grace: nothing for this business
  r := clicktide_retention_purge(false);
  if not exists (select 1 from customers where user_id = biz) then raise exception 'FAIL: deleted inside grace'; end if;
  -- age it past 90 days
  update clicktide set data_closed_at = now() - interval '91 days' where user_id = biz;  -- trigger keeps old value...
  if (select data_closed_at from clicktide where user_id = biz) > now() - interval '90 days' then
    alter table clicktide disable trigger clicktide_retention_closed_at;
    update clicktide set data_closed_at = now() - interval '91 days' where user_id = biz;
    alter table clicktide enable trigger clicktide_retention_closed_at;
  end if;
  r := clicktide_retention_purge(true);
  if exists (select 1 from customers where user_id = biz) is false then raise exception 'FAIL: dry run deleted'; end if;
  r := clicktide_retention_purge(false);
  if exists (select 1 from customers where user_id = biz) then raise exception 'FAIL: closed customers kept %', r; end if;
  if not exists (select 1 from customers where user_id = live) then raise exception 'FAIL: live customers deleted'; end if;
  if (select access_token from platform_connections where user_id = biz) <> '' then raise exception 'FAIL: token kept'; end if;
  if not exists (select 1 from clicktide where user_id = biz) then raise exception 'FAIL: business row deleted'; end if;
  -- resubscribe clears the clock
  update clicktide set stripe_subscription_status = 'active' where user_id = biz;
  if (select data_closed_at from clicktide where user_id = biz) is not null then raise exception 'FAIL: resubscribe kept clock'; end if;
  raise exception 'ALL RETENTION TESTS PASSED %', r;
end $t$;
