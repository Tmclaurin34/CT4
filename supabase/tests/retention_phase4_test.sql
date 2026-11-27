-- Phase 4: Customer Intelligence RPC. Always rolled back. Run: supabase/tests/run_retention_tests.sh
do $$
declare
  biz   uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  other uuid := '1540daa6-5a6e-4059-bf6c-22c9d392b909';
  today date := (now() at time zone 'America/New_York')::date;
  pass int := 0; fail int := 0; msgs text := '';
  cw bigint; cv bigint; cn bigint; i int; j json; r json; n int; base_all int; base_risk int;
begin
  -- baseline before our test customers
  perform set_config('request.jwt.claims', json_build_object('sub', biz, 'role', 'authenticated')::text, true);
  set local role authenticated;
  j := clicktide_customer_intelligence('all','',  'priority', 50, 0);
  reset role;
  base_all := (j->'counts'->>'all')::int; base_risk := (j->'counts'->>'at_risk')::int;

  -- weekly regular gone 12 days -> drifting, reachable by email
  insert into customers(user_id, name, email, visits, total_spent, status)
    values (biz, 'P4 Weekly', 'p4-weekly@example.com', 10, 120, 'active') returning id into cw;
  for i in 0..9 loop
    perform clicktide_record_visit(biz, cw, ((today - 12 - 7*i)::timestamp + time '15:00') at time zone 'America/New_York', 12, 'square', 'p4-w-'||i);
  end loop;
  -- big spender weekly, gone 60 days -> at risk, high value
  insert into customers(user_id, name, email, visits, total_spent, status)
    values (biz, 'P4 VIP', 'p4-vip@example.com', 10, 99999, 'active') returning id into cv;
  for i in 0..9 loop
    perform clicktide_record_visit(biz, cv, ((today - 60 - 7*i)::timestamp + time '15:00') at time zone 'America/New_York', 500, 'square', 'p4-v-'||i);
  end loop;
  -- weekly, gone 60 days, no contact at all -> at risk, needs contact
  insert into customers(user_id, name, visits, total_spent, status)
    values (biz, 'P4 Nocontact', 10, 50, 'active') returning id into cn;
  for i in 0..9 loop
    perform clicktide_record_visit(biz, cn, ((today - 60 - 7*i)::timestamp + time '15:00') at time zone 'America/New_York', 5, 'square', 'p4-n-'||i);
  end loop;
  perform clicktide_refresh_rhythm(biz);

  set local role authenticated;
  j := clicktide_customer_intelligence('all','P4 ','priority', 50, 0);
  reset role;
  -- 1 three rows, at-risk first, then drifting
  if (j->>'total')::int = 3 and (j->'rows'->0->>'status') = 'at_risk' and (j->'rows'->2->>'status') = 'drifting'
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [order '||left((j->'rows')::text,300)||']'; end if;
  -- 2 next actions
  select x into r from json_array_elements(j->'rows') x where x->>'name' = 'P4 VIP';
  if r->>'next_action' like 'High-value%' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [vip action '||coalesce(r->>'next_action','null')||']'; end if;
  select x into r from json_array_elements(j->'rows') x where x->>'name' = 'P4 Nocontact';
  if r->>'next_action' like 'Add an email or phone%' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [nocontact action]'; end if;
  select x into r from json_array_elements(j->'rows') x where x->>'name' = 'P4 Weekly';
  if r->>'next_action' like 'Just past%' and (r->>'expected_interval')::numeric = 7 and (r->>'days_vs_usual')::int = 5
     and (r->>'confidence') = 'high' and length(r->>'reason') > 10
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [weekly row '||r::text||']'; end if;
  -- 3 counts include ours
  set local role authenticated;
  j := clicktide_customer_intelligence('all','','priority', 50, 0);
  reset role;
  if (j->'counts'->>'all')::int = base_all + 3 and (j->'counts'->>'at_risk')::int = base_risk + 2
     and (j->'counts'->>'needs_contact')::int >= 1 and (j->>'engine') = 'rhythm'
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [counts '||(j->'counts')::text||']'; end if;
  -- 4 filters + sorting
  set local role authenticated;
  j := clicktide_customer_intelligence('needs_contact','P4 ','priority', 50, 0);
  n := (j->>'total')::int;
  r := clicktide_customer_intelligence('all','P4 ','overdue', 1, 0);
  reset role;
  if n = 1 and (j->'rows'->0->>'name') = 'P4 Nocontact' and (r->>'total')::int = 3 and json_array_length(r->'rows') = 1
     and (r->'rows'->0->>'name') in ('P4 VIP','P4 Nocontact')
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [filter/sort]'; end if;
  -- 5 tenant isolation: another business sees none of these customers
  perform set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  set local role authenticated;
  j := clicktide_customer_intelligence('all','P4 ','priority', 50, 0);
  reset role;
  if (j->>'total')::int = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [LEAK to other business]'; end if;
  -- 6 anonymous callers are refused
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    set local role anon;
    j := clicktide_customer_intelligence('all','','priority', 50, 0);
    reset role;
    fail := fail + 1; msgs := msgs || ' [anon could call]';
  exception when insufficient_privilege then
    reset role; pass := pass + 1;
  end;

  raise exception 'RETENTION TESTS: % passed, % failed.%', pass, fail, msgs;
end $$;
