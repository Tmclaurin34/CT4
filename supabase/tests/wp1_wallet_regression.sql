-- Security session's WP1 TESTS.md §1-§2 (2a, 2b, 2d; 2c needs two live sessions), as one block
-- that records every result and raises it, so it can be run before and after a ledger change
-- and the outputs compared. Everything is rolled back.
do $t$
declare
  u uuid := '675f5e6d-2de0-43e3-91f9-8126b5e6967a';
  staff uuid := (select user_id from clicktide_staff where is_active and role = 'admin' limit 1);
  b numeric; res jsonb := '[]'::jsonb; x text;
  procedure_dummy int;
begin
  b := clicktide_wallet_balance(u);
  -- 2a
  res := res || jsonb_build_array(clicktide_wallet_apply(u, 10, 'test', 'WP1 bad kind', null, null));
  res := res || jsonb_build_array(clicktide_wallet_apply(u, -10, 'topup', 'WP1 wrong sign', null, null));
  res := res || jsonb_build_array(clicktide_wallet_apply(u, 10, 'topup', 'WP1 test credit', null, 'wp1-test-credit') - 'balance' || jsonb_build_object('d', clicktide_wallet_balance(u) - b));
  res := res || jsonb_build_array(clicktide_wallet_apply(u, 10, 'topup', 'WP1 test credit', null, 'wp1-test-credit') - 'balance' || jsonb_build_object('d', clicktide_wallet_balance(u) - b));
  res := res || jsonb_build_array(clicktide_wallet_apply(u, -1000000, 'gift_debit', 'too much', null, null) - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_apply(u, 0.004, 'topup', 'rounds to zero', null, null));
  res := res || jsonb_build_array(jsonb_build_object('server_debit_d', clicktide_debit_gift_wallet_server(u, 1.50, 'WP1 test debit', null) - b));
  insert into wallet (user_id, "desc", amount, balance, transaction_type) values (u, 'WP1 legacy-style insert', 1, 999999, 'reversal');
  res := res || jsonb_build_array((select jsonb_build_object('amount', amount, 'd', round(balance::double precision::numeric, 2) - b) from wallet where user_id = u order by created_at desc, id desc limit 1));
  begin perform clicktide_debit_gift_wallet_server(u, 1000000, 'WP1 overdraft test', null); x := 'no error';
  exception when others then x := sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_object('overdraft', x));
  -- 2b staff may not add credit
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',staff,'aal','aal2')::text, true);
  set local role authenticated;
  begin insert into wallet (user_id, amount, balance, transaction_type) values (u, 5, 999, 'topup'); x := 'no error';
  exception when others then x := sqlerrm; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('staff_credit', x));
  -- 2b staff refund computed by the database
  b := clicktide_wallet_balance(u);
  perform clicktide_wallet_apply(u, 5, 'topup', 'WP1 setup', null, null);
  set local role authenticated;
  begin insert into wallet (user_id, "desc", amount, balance, transaction_type, note, created_by)
    values (u, 'Unused gift wallet refund', -1, 999999, 'refund', 'WP1 test', '00000000-0000-0000-0000-000000000000'); x := 'ok';
  exception when others then x := sqlerrm; end;
  reset role;
  res := res || jsonb_build_array((select jsonb_build_object('staff_refund', x, 'amount', amount, 'd', round(balance::double precision::numeric, 2) - b, 'by_staff', created_by = staff) from wallet where user_id = u order by created_at desc, id desc limit 1));
  -- 2b precision
  b := clicktide_wallet_balance(u);
  perform clicktide_wallet_apply(u, 12345.67, 'topup', 'WP1 precision', null, null);
  perform clicktide_wallet_apply(u, -0.01, 'gift_debit', 'WP1 precision', null, null);
  res := res || jsonb_build_array(jsonb_build_object('precision_d', clicktide_wallet_balance(u) - b));
  -- 2b non-staff can't write
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"eba3d94c-99da-4468-9546-57a1ee9b3330"}', true);
  set local role authenticated;
  begin insert into wallet (user_id, amount, transaction_type) values ('eba3d94c-99da-4468-9546-57a1ee9b3330', -1, 'refund'); x := 'no error';
  exception when others then x := sqlerrm; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('non_staff', x));
  -- 2d top-up, refund, chargeback, reinstate
  b := clicktide_wallet_balance(u);
  res := res || jsonb_build_array(clicktide_wallet_credit_topup(u, 50, 'cs_wp1_test', 'pi_wp1_test', null, 'WP1 test top-up') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_credit_topup(u, 50, 'cs_wp1_test', 'pi_wp1_test', null, 'WP1 test top-up') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reverse_topup('pi_wp1_test', 'ch_wp1_test', 'refund', 20, 'Top-up refunded') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reverse_topup('pi_wp1_test', 'ch_wp1_test', 'refund', 20, 'Top-up refunded') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reverse_topup('pi_wp1_test', 'dp_wp1_test', 'dispute', 1000, 'Charged back') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reinstate('dp_wp1_test', 'pi_wp1_test', 'Chargeback won') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reinstate('dp_wp1_test', 'pi_wp1_test', 'Chargeback won') - 'balance');
  res := res || jsonb_build_array(clicktide_wallet_reverse_topup('pi_none', 'ch_none', 'refund', 5, 'x') - 'balance');
  res := res || jsonb_build_array(jsonb_build_object('2d_net_d', clicktide_wallet_balance(u) - b));
  -- 2d debt after spend
  perform clicktide_wallet_credit_topup(u, 50, 'cs_wp1_debt', 'pi_wp1_debt', null, 'WP1 test top-up');
  perform clicktide_debit_gift_wallet_server(u, clicktide_wallet_balance(u) - 5, 'WP1 test spend', null);
  perform clicktide_wallet_reverse_topup('pi_wp1_debt', 'dp_wp1_debt', 'dispute', 50, 'Charged back');
  perform clicktide_wallet_credit_topup(u, 30, 'cs_wp1_debt2', 'pi_wp1_debt2', null, 'WP1 second top-up');
  res := res || jsonb_build_array((select jsonb_build_object('taken', taken, 'owed', owed, 'recovered', recovered) from wallet_reversals where reference = 'dp_wp1_debt'));
  raise exception 'WP1RESULT %', res;
end $t$;
