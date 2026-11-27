-- Phase 3 parity tests: the dashboard RPC and the free audit report must agree with
-- the rhythm engine. Always rolled back. Run: supabase/tests/run_retention_tests.sh
do $$
declare
  biz uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  today date := (now() at time zone 'America/New_York')::date;
  pass int := 0; fail int := 0; msgs text := '';
  cw bigint; cm bigint; i int; j json; jr jsonb; a uuid; n int; st text;
begin
  -- weekly regular gone 12 days: engine says DRIFTING; the old rule (14-day floor) said healthy
  insert into customers(user_id, name, email, visits, total_spent, status)
    values (biz, 'P3 Weekly', 'p3-weekly@example.com', 10, 120, 'active') returning id into cw;
  for i in 0..9 loop
    perform clicktide_record_visit(biz, cw, ((today - 12 - 7*i)::timestamp + time '15:00') at time zone 'America/New_York', 12, 'square', 'p3-w-'||i);
  end loop;
  update customers set last_visit_at = ((today - 12)::timestamp + time '15:00') at time zone 'America/New_York',
                       first_order_at = ((today - 75)::timestamp + time '15:00') at time zone 'America/New_York' where id = cw;
  -- monthly regular gone 40 days: HEALTHY (a flat 30-day timer would flag this)
  insert into customers(user_id, name, email, visits, total_spent, status)
    values (biz, 'P3 Monthly', 'p3-monthly@example.com', 8, 400, 'active') returning id into cm;
  for i in 0..7 loop
    perform clicktide_record_visit(biz, cm, ((today - 40 - 30*i)::timestamp + time '15:00') at time zone 'America/New_York', 50, 'square', 'p3-m-'||i);
  end loop;
  update customers set last_visit_at = ((today - 40)::timestamp + time '15:00') at time zone 'America/New_York',
                       first_order_at = ((today - 250)::timestamp + time '15:00') at time zone 'America/New_York' where id = cm;
  perform clicktide_refresh_rhythm(biz);

  -- 1 dashboard RPC agrees with the engine
  perform set_config('request.jwt.claims', json_build_object('sub', biz, 'role', 'authenticated')::text, true);
  set local role authenticated;
  j := clicktide_customers(60, 'drifting', 'P3 ', null, null, 100, 0);
  reset role;
  select count(*) into n from json_array_elements(j->'rows') x where (x->>'name') = 'P3 Weekly' and x->>'rhythm_status' = 'drifting';
  if n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [rpc weekly not drifting: '||left((j->'rows')::text,300)||']'; end if;
  select count(*) into n from json_array_elements(j->'rows') x where (x->>'name') = 'P3 Monthly';
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [rpc monthly wrongly drifting]'; end if;
  set local role authenticated;
  j := clicktide_customers(60, 'all', 'P3 ', null, null, 100, 0);
  reset role;
  select x->>'rhythm_status' into st from json_array_elements(j->'rows') x where x->>'name' = 'P3 Monthly';
  if st = 'healthy' and (j->>'engine') = 'rhythm' and (j->'rows'->0)::jsonb ? 'rhythm_reason' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [rpc monthly status '||coalesce(st,'null')||']'; end if;
  select (x->>'eff_churn')::int into n from json_array_elements(j->'rows') x where x->>'name' = 'P3 Weekly';
  if n = (select round(drift_after_days)::int from customer_rhythm where customer_id = cw) then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [eff_churn not engine '||n||']'; end if;

  -- 2 free audit report uses the same engine
  insert into pos_audits(user_id, source, platform) values (biz, 'csv', 'csv') returning id into a;
  -- 6 weekly, recent  (healthy)
  insert into pos_audit_facts(audit_id, visits, spend, first_at, last_at, visit_days)
    select a, 10, 100, now() - interval '66 days', now() - interval '3 days',
           (select array_agg((now() at time zone 'UTC')::date - 3 - 7*k) from generate_series(0,9) k)
    from generate_series(1,6);
  -- 5 weekly, gone 12 days (drifting)
  insert into pos_audit_facts(audit_id, visits, spend, first_at, last_at, visit_days)
    select a, 10, 100, now() - interval '75 days', now() - interval '12 days',
           (select array_agg((now() at time zone 'UTC')::date - 12 - 7*k) from generate_series(0,9) k)
    from generate_series(1,5);
  -- 3 monthly, gone 40 days (healthy for THEM)
  insert into pos_audit_facts(audit_id, visits, spend, first_at, last_at, visit_days)
    select a, 8, 400, now() - interval '250 days', now() - interval '40 days',
           (select array_agg((now() at time zone 'UTC')::date - 40 - 30*k) from generate_series(0,7) k)
    from generate_series(1,3);
  -- 2 one-visit customers
  insert into pos_audit_facts(audit_id, visits, spend, first_at, last_at, visit_days)
    select a, 1, 20, now() - interval '5 days', now() - interval '5 days', array[(now() at time zone 'UTC')::date - 5]
    from generate_series(1,2);
  jr := clicktide_audit_build_report(a, 60);
  if (jr->'drifting'->>'count')::int = 5 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [audit drifting '||(jr->'drifting'->>'count')||']'; end if;
  if (jr->'confidence'->>'insufficient')::int = 2 and (jr->>'baseline_source') = 'business' and (jr->>'engine') = 'rhythm'
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [audit conf/baseline '||(jr->'confidence')::text||' '||(jr->>'baseline_source')||']'; end if;
  if (jr->'drifting'->'buckets'->>'just_past')::int = 5 then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [audit buckets '||(jr->'drifting'->'buckets')::text||']'; end if;
  -- old-style facts with no dates still work (summary path)
  update pos_audit_facts set visit_days = null where audit_id = a;
  jr := clicktide_audit_build_report(a, 60);
  if (jr->'drifting'->>'count') is not null then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [audit no-dates broke]'; end if;

  raise exception 'RETENTION TESTS: % passed, % failed.%', pass, fail, msgs;
end $$;
