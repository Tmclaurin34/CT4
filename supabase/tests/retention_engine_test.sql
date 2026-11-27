-- Retention engine scenario tests. Runs entirely inside one transaction that is
-- ALWAYS rolled back (it ends by raising the results as an exception), so it never
-- leaves data behind. Run: supabase/tests/run_retention_tests.sh
do $$
declare
  t date := date '2026-11-26';
  now_ts timestamptz := timestamptz '2026-11-26 18:00:00+00';
  biz uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';     -- Clicktide test business (Scale plan)
  pass int := 0; fail int := 0; msgs text := '';
  r record; d date[]; i int; cid bigint; cid2 bigint; cid3 bigint; res text; camp bigint; j jsonb; n int;
  procedure_ok boolean;
begin
  -- helper pattern: each check appends to pass/fail
  ------------------------------------------------------------------ pure core
  -- 1 DAILY regular, last visit yesterday → healthy, high confidence, ~1 day rhythm
  select array_agg(t - k) into d from generate_series(1, 60) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 10, 'category', t);
  if r.expected_interval = 1 and r.base_status = 'healthy' and r.confidence = 'high' and r.interval_source = 'observed'
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [daily healthy: %s %s %s]', r.expected_interval, r.base_status, r.confidence); end if;
  -- 1b DAILY regular gone 6 days → drifting (not "fine for another month")
  select array_agg(t - 5 - k) into d from generate_series(1, 60) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.base_status = 'drifting' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [daily 6d: %s after %s]', r.base_status, r.drift_after_days); end if;
  -- 1c DAILY regular gone 14 days → at risk
  select array_agg(t - 13 - k) into d from generate_series(1, 60) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.base_status = 'at_risk' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [daily 14d: %s]', r.base_status); end if;

  -- 2 WEEKLY: 5 days → healthy, 12 → drifting, 20 → at risk
  select array_agg(t - 5 - 7*k) into d from generate_series(0, 19) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.expected_interval = 7 and r.base_status = 'healthy' and r.confidence = 'high' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [weekly 5d: %s %s %s]', r.expected_interval, r.base_status, r.confidence); end if;
  select array_agg(t - 12 - 7*k) into d from generate_series(0, 19) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.base_status = 'drifting' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [weekly 12d: %s]', r.base_status); end if;
  select array_agg(t - 20 - 7*k) into d from generate_series(0, 19) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.base_status = 'at_risk' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [weekly 20d: %s]', r.base_status); end if;

  -- 3 MONTHLY: 40 days since → still HEALTHY (a flat 30-day timer would wrongly flag this)
  select array_agg(t - 40 - 30*k) into d from generate_series(0, 11) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 7, 'category', t);
  if r.expected_interval = 30 and r.base_status = 'healthy' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [monthly 40d: %s %s]', r.expected_interval, r.base_status); end if;
  select array_agg(t - 60 - 30*k) into d from generate_series(0, 11) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 7, 'category', t);
  if r.base_status = 'drifting' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [monthly 60d: %s]', r.base_status); end if;
  select array_agg(t - 90 - 30*k) into d from generate_series(0, 11) k;
  select * into r from clicktide_rhythm_core(d, null, null, null, 7, 'category', t);
  if r.base_status = 'at_risk' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [monthly 90d: %s]', r.base_status); end if;

  -- 4 IRREGULAR: wide variability → lower confidence and a wider window than a steady customer
  d := array[t-200, t-195, t-165, t-153, t-108, t-100, t-80, t-20, t-10]::date[];
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.confidence in ('low','medium') and r.variability > 0.6 and r.drift_after_days >= r.expected_interval * 2
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [irregular: conf %s var %s drift %s exp %s]', r.confidence, r.variability, r.drift_after_days, r.expected_interval); end if;

  -- 5 SEASONAL: weekly every summer, nothing in between → break excluded, rhythm stays weekly, hint set
  select array_agg(x) into d from (
    select date '2025-06-01' + 7*k x from generate_series(0, 12) k
    union all select date '2026-06-01' + 7*k from generate_series(0, 12) k) s;
  select * into r from clicktide_rhythm_core(d, null, null, null, 30, 'category', t);
  if r.expected_interval = 7 and r.breaks_excluded >= 1 and r.seasonal_hint then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [seasonal: exp %s breaks %s hint %s]', r.expected_interval, r.breaks_excluded, r.seasonal_hint); end if;

  -- 6 ONE VISIT: no personal prediction, uses the business/category rhythm, says so
  select * into r from clicktide_rhythm_core(array[t-10]::date[], null, null, null, 21, 'category', t);
  if r.confidence = 'insufficient' and r.interval_source = 'category' and r.expected_interval = 21 and r.gaps_used = 0
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [one visit: %s %s %s]', r.confidence, r.interval_source, r.expected_interval); end if;
  if clicktide_rhythm_reason('healthy','visit_history',1,0,21,'category',null,10,0.48,false,null) like 'Only 1 visit — no personal rhythm yet.%'
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [one visit reason]'; end if;

  -- 7 TWO VISITS: blended between own gap (10) and business rhythm (30), low confidence
  select * into r from clicktide_rhythm_core(array[t-30, t-20]::date[], null, null, null, 30, 'category', t);
  if r.interval_source = 'blended' and r.confidence = 'low' and r.expected_interval > 10 and r.expected_interval < 30
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [two visits: %s %s %s]', r.interval_source, r.confidence, r.expected_interval); end if;

  -- 8 MISSING HISTORY (summary counters only): averaged, never more than low confidence
  select * into r from clicktide_rhythm_core(null, 10, date '2026-01-01', date '2026-11-01', 30, 'category', t);
  if r.data_basis = 'summary_only' and r.interval_source = 'summary_average' and r.confidence = 'low' and abs(r.expected_interval - 33.9) < 0.2
    then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [summary: %s %s %s %s]', r.data_basis, r.interval_source, r.confidence, r.expected_interval); end if;
  -- 8b nothing at all
  select * into r from clicktide_rhythm_core(null, 0, null, null, 30, 'category', t);
  if r.base_status = 'no_history' and r.confidence = 'insufficient' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [none: %s]', r.base_status); end if;

  -- 9 same-day duplicates in the date list count once
  select * into r from clicktide_rhythm_core(array[t-14, t-14, t-14, t-7, t-7, t]::date[], null, null, null, 30, 'category', t);
  if r.visits_observed = 3 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [dup dates: %s]', r.visits_observed); end if;

  ------------------------------------------------------------------ ledger + engine (integration)
  insert into customers(user_id, name, email, visits, total_spent, status, sms_consent)
    values (biz, 'Test Weekly', 'qa-weekly@example.com', 0, 0, 'active', false) returning id into cid;

  -- 10 MULTIPLE TRANSACTIONS SAME DAY = one visit (coffee + muffin rung up separately)
  res := clicktide_record_visit(biz, cid, timestamptz '2026-09-01 14:00+00', 4.50, 'square', 'qa-sq-1');
  if res <> 'new_visit' then fail := fail + 1; msgs := msgs || ' [first txn '||res||']'; else pass := pass + 1; end if;
  res := clicktide_record_visit(biz, cid, timestamptz '2026-09-01 14:05+00', 3.25, 'square', 'qa-sq-2');
  if res = 'same_visit' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [same day '||res||']'; end if;
  -- 11 DUPLICATE POS TRANSACTION (re-synced) is ignored entirely
  res := clicktide_record_visit(biz, cid, timestamptz '2026-09-01 14:05+00', 3.25, 'square', 'qa-sq-2');
  if res = 'duplicate' then pass := pass + 1; else fail := fail + 1; msgs := msgs || ' [dup '||res||']'; end if;
  select count(*), max(txn_count) into n, i from customer_visits where customer_id = cid;
  if n = 1 and i = 2 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [ledger rows %s txns %s]', n, i); end if;
  -- 12 local-day grouping: 11:30pm New York and 12:30am the next day are different days
  res := clicktide_record_visit(biz, cid, timestamptz '2026-09-09 03:30+00', 5, 'square', 'qa-sq-3');  -- Sep 8, 11:30pm ET
  res := clicktide_record_visit(biz, cid, timestamptz '2026-09-09 04:30+00', 5, 'square', 'qa-sq-4');  -- Sep 9, 12:30am ET
  select count(*) into n from customer_visits where customer_id = cid;
  if n = 3 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [local day split: %s rows]', n); end if;
  -- 12b configurable merge window: with 2h merging, those two would be one visit
  update clicktide set visit_merge_hours = 2 where user_id = biz;
  insert into customers(user_id, name, email, visits, total_spent, status) values (biz, 'Test Merge', 'qa-merge@example.com', 0, 0, 'active') returning id into cid3;
  res := clicktide_record_visit(biz, cid3, timestamptz '2026-09-09 03:30+00', 5, 'clover', 'qa-cl-1');
  res := clicktide_record_visit(biz, cid3, timestamptz '2026-09-09 04:30+00', 5, 'clover', 'qa-cl-2');
  select count(*) into n from customer_visits where customer_id = cid3;
  if n = 1 and res = 'same_visit' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [merge window: %s rows, %s]', n, res); end if;
  update clicktide set visit_merge_hours = 0 where user_id = biz;

  -- weekly history for the engine: visits every 7 days through Oct 22, then nothing
  delete from customer_visits where customer_id = cid; delete from pos_transactions_seen where customer_id = cid;
  for i in 0..9 loop
    perform clicktide_record_visit(biz, cid, timestamptz '2026-08-20 15:00+00' + make_interval(days => 7*i), 12, 'square', 'qa-w-'||i);
  end loop;
  update customers set visits = 10, last_visit_at = timestamptz '2026-10-22 15:00+00', first_order_at = timestamptz '2026-08-20 15:00+00' where id = cid;

  -- 13 refresh on Oct 25 → healthy
  j := clicktide_refresh_rhythm(biz, timestamptz '2026-10-25 18:00+00');
  select * into r from customer_rhythm where customer_id = cid;
  if r.status = 'healthy' and r.expected_interval = 7 and r.data_basis = 'visit_history' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [refresh healthy: %s %s %s]', r.status, r.expected_interval, r.data_basis); end if;
  -- 14 refresh on Nov 3 (12 days) → drifting, with a status-change event
  j := clicktide_refresh_rhythm(biz, timestamptz '2026-11-03 18:00+00');
  select * into r from customer_rhythm where customer_id = cid;
  select count(*) into n from customer_status_events where customer_id = cid and from_status = 'healthy' and to_status = 'drifting';
  if r.status = 'drifting' and n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [drifting: %s events %s]', r.status, n); end if;
  -- 14b refreshing again the same day creates no duplicate event
  j := clicktide_refresh_rhythm(biz, timestamptz '2026-11-03 19:00+00');
  select count(*) into n from customer_status_events where customer_id = cid and to_status = 'drifting';
  if n = 1 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [dup drift events: %s]', n); end if;
  -- 14c moving on to at_risk keeps the same drift episode (no second win-back)
  select episode_started_at into now_ts from customer_rhythm where customer_id = cid;
  j := clicktide_refresh_rhythm(biz, timestamptz '2026-11-12 18:00+00');
  select * into r from customer_rhythm where customer_id = cid;
  if r.status = 'at_risk' and r.episode_started_at = timestamptz '2026-11-03 18:00+00' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [episode: %s %s]', r.status, r.episode_started_at); end if;
  now_ts := timestamptz '2026-11-26 18:00:00+00';
  -- 15 RETURNS → recovered, then back to healthy once settled
  perform clicktide_record_visit(biz, cid, timestamptz '2026-11-05 15:00+00', 12, 'square', 'qa-w-ret');
  update customers set visits = 11, last_visit_at = timestamptz '2026-11-05 15:00+00' where id = cid;
  j := clicktide_refresh_rhythm(biz, timestamptz '2026-11-06 18:00+00');
  select * into r from customer_rhythm where customer_id = cid;
  if r.status = 'recovered' and r.reason like '%Came back after drifting.%' and r.episode_started_at is null then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [recovered: %s / %s]', r.status, r.reason); end if;

  -- 16 RETURN AFTER A WIN-BACK MESSAGE (customer the engine never saw drift) → recovered via win-back
  insert into customers(user_id, name, email, visits, total_spent, status, last_visit_at, first_order_at)
    values (biz, 'Test Winback', 'qa-wb@example.com', 6, 120, 'active', now_ts - interval '3 days', now_ts - interval '120 days') returning id into cid2;
  insert into campaigns(user_id, name, trigger, status, campaign_type) values (biz, 'QA win-back', 'Inactive / win-back', 'paused', 'digital_gift') returning id into camp;
  insert into campaign_sends(user_id, campaign_id, customer_id, channel, status, sent_at) values (biz, camp, cid2, 'email', 'sent', now_ts - interval '10 days');
  j := clicktide_refresh_rhythm(biz, now_ts);
  select * into r from customer_rhythm where customer_id = cid2;
  if r.status = 'recovered' and r.reason like '%after a win-back message%' then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [winback return: %s / %s]', r.status, r.reason); end if;

  -- 17 privacy: another business cannot read this business's rhythm rows
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from customer_rhythm where user_id = biz;
  reset role;
  if n = 0 then pass := pass + 1; else fail := fail + 1; msgs := msgs || format(' [rls leak %s]', n); end if;
  -- 17b and browsers can't write the ledger
  perform set_config('request.jwt.claims', json_build_object('sub', biz, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into customer_visits(user_id, customer_id, visited_on, first_at, last_at) values (biz, cid, t, now_ts, now_ts);
    fail := fail + 1; msgs := msgs || ' [browser wrote ledger]';
  exception when others then pass := pass + 1; end;
  begin
    perform clicktide_record_visit(biz, cid, now_ts, 1, 'x', 'y');
    fail := fail + 1; msgs := msgs || ' [browser called record_visit]';
  exception when others then pass := pass + 1; end;
  reset role;

  raise exception 'RETENTION TESTS: % passed, % failed.%', pass, fail, msgs;
end $$;
