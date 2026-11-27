-- Staff access log (Shopify protected customer data: "log access to personal data").
-- * Back office reads: the page calls clicktide_log_staff_access(client, view) before
--   showing a client's data (Postgres cannot trigger on SELECT).
-- * Staff writes: a row trigger logs every insert/update/delete a staff member makes
--   on another business's data (owners editing their own rows and service-role jobs
--   are not logged). Only column NAMES are stored, never values, so the log holds no PII.
-- * The log is append-only: no client role can insert/update/delete it directly.

create or replace function public.clicktide_log_staff_access(p_client uuid, p_view text, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.clicktide_is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;
  if p_client is not null and not public.clicktide_can_access_client(p_client) then
    raise exception 'no access to this client' using errcode = '42501';
  end if;
  insert into public.clicktide_admin_audit_log(actor_user_id, client_user_id, action, target_table, details)
  values (auth.uid(), p_client, 'view', left(coalesce(p_view, ''), 60), coalesce(p_details, '{}'::jsonb));
end $$;
revoke all on function public.clicktide_log_staff_access(uuid, text, jsonb) from public, anon;
grant execute on function public.clicktide_log_staff_access(uuid, text, jsonb) to authenticated;

create or replace function public.clicktide_audit_staff_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  owner uuid := nullif(r->>'user_id', '')::uuid;
  cols text[];
begin
  if auth.uid() is null or auth.uid() is not distinct from owner then return null; end if;
  if not public.clicktide_is_staff() then return null; end if;
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into cols
    from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from (to_jsonb(old) -> n.key);
  end if;
  insert into public.clicktide_admin_audit_log(actor_user_id, client_user_id, action, target_table, target_id, details)
  values (auth.uid(), owner, lower(tg_op), tg_table_name, coalesce(r->>'id', r->>'user_id'),
          case when cols is null then '{}'::jsonb else jsonb_build_object('columns', to_jsonb(cols)) end);
  return null;
end $$;
revoke all on function public.clicktide_audit_staff_write() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['customers','clicktide','campaigns','shipments','platform_connections','wallet'] loop
    execute format('drop trigger if exists zz_staff_audit on public.%I', t);
    execute format('create trigger zz_staff_audit after insert or update or delete on public.%I for each row execute function public.clicktide_audit_staff_write()', t);
  end loop;
end $$;

drop policy if exists audit_staff_insert on public.clicktide_admin_audit_log;
revoke insert, update, delete, truncate on public.clicktide_admin_audit_log from anon, authenticated;
revoke all on public.clicktide_admin_audit_log from anon;
create index if not exists clicktide_admin_audit_log_client_idx on public.clicktide_admin_audit_log(client_user_id, created_at desc);
