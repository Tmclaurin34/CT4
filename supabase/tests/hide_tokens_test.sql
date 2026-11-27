do $t$
declare u uuid := (select user_id from clicktide where user_id is not null limit 1); ok boolean := false; n int;
begin
  insert into platform_connections(user_id, platform, merchant_id, access_token, is_active) values (u, 'zzz', 'm', 'secret', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from (select platform, merchant_name, is_active from platform_connections) x;
  begin perform access_token from platform_connections limit 1; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: token readable'; end if;
  update platform_connections set is_active = is_active where user_id = u and platform = 'zzz';
  reset role;
  if n < 1 then raise exception 'FAIL: own row not visible'; end if;
  raise exception 'ALL TOKEN TESTS PASSED (rows visible %)', n;
end $t$;
