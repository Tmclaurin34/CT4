-- Run inside a transaction; ends with raise exception so nothing is kept.
do $t$
declare
  staff uuid := (select user_id from clicktide_staff where is_active and role='admin' limit 1);
  client uuid; cust bigint; n int; d jsonb; ok boolean;
begin
  select c.user_id, c.id into client, cust from customers c where c.user_id <> staff order by c.id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', staff, 'role','authenticated','aal','aal2')::text, true);
  set local role authenticated;
  -- 1 view log via RPC
  perform clicktide_log_staff_access(client, 'customers');
  -- 2 staff update on another business's customer -> logged with column names only
  update customers set name = name || ' ' where id = cust;
  -- 3 direct insert into the log is refused
  ok := false;
  begin insert into clicktide_admin_audit_log(actor_user_id, action) values (staff, 'forged'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: direct insert allowed'; end if;
  -- 4 delete of log refused
  ok := false;
  begin delete from clicktide_admin_audit_log; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: delete allowed'; end if;
  reset role;
  select count(*) into n from clicktide_admin_audit_log where actor_user_id = staff and client_user_id = client and action='view' and target_table='customers';
  if n <> 1 then raise exception 'FAIL: view not logged (%)', n; end if;
  select details into d from clicktide_admin_audit_log where actor_user_id = staff and action='update' and target_table='customers' and target_id = cust::text;
  if d is null or not (d->'columns') ? 'name' then raise exception 'FAIL: update not logged %', d; end if;
  -- 5 non-staff user cannot call the RPC
  perform set_config('request.jwt.claims', json_build_object('sub', client, 'role','authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin perform clicktide_log_staff_access(client, 'x'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: non-staff could log'; end if;
  -- 6 owner editing own row is not logged
  update customers set name = name where id = cust;
  reset role;
  select count(*) into n from clicktide_admin_audit_log where actor_user_id = client;
  if n <> 0 then raise exception 'FAIL: owner write logged'; end if;
  raise exception 'ALL STAFF LOG TESTS PASSED';
end $t$;
