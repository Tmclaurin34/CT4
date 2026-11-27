-- WP6: staff helpers, partner write scope, staff-written audit rows, profile-change codes.
--   * clicktide_is_staff / clicktide_can_access_client / clicktide_can_manage_fulfillment keep
--     their names, arguments and answers; they gain search_path = '' and one more condition,
--     public.clicktide_staff_session_ok(), which stays true until 99_staff_mfa_required_c6.sql
--     switches the 'staff_require_mfa' flag on (contract C6). The flag lives in a table so
--     re-running this file never switches MFA enforcement off again.
--   * Partners keep read access to their assigned clients, but writing a client's customers,
--     campaigns or business row now needs the matching per-client flag.
--   * Staff-written audit rows must name the caller as the actor.
--   * Owners can no longer read business_profile_changes, which holds code_hash
--     (sha256 of user id + a 6-digit code, brute-forced offline in under a second).
-- Only WP6 should redefine the staff helpers, or the MFA condition can be lost.
-- Idempotent: safe to run more than once.

-- 1. Security flags (service role and SQL editor only).
create table if not exists public.clicktide_security_flags (
  flag       text primary key,
  enabled    boolean not null default false,
  note       text,
  updated_at timestamptz not null default now()
);
alter table public.clicktide_security_flags enable row level security;
revoke all on table public.clicktide_security_flags from public, anon, authenticated;

insert into public.clicktide_security_flags (flag, enabled, note)
values ('staff_require_mfa', false, 'C6: when on, staff helpers require an aal2 (MFA) session')
on conflict (flag) do nothing;

-- 2. Called only from the SECURITY DEFINER helpers below, so it runs as their owner.
create or replace function public.clicktide_staff_session_ok()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not coalesce((select f.enabled
                         from public.clicktide_security_flags f
                        where f.flag = 'staff_require_mfa'), false);
$$;
revoke all on function public.clicktide_staff_session_ok() from public, anon, authenticated;

-- 3. Staff helpers.
create or replace function public.clicktide_is_staff(required_roles text[] default array['admin','support','partner'])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1
             from public.clicktide_staff s
            where s.user_id = auth.uid()
              and s.is_active
              and s.role = any (required_roles)
         )
     and public.clicktide_staff_session_ok();
$$;

create or replace function public.clicktide_can_access_client(client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() = client_id
      or (
           (
             exists (
               select 1
                 from public.clicktide_staff s
                where s.user_id = auth.uid()
                  and s.is_active
                  and s.role in ('admin', 'support')
             )
             or exists (
               select 1
                 from public.clicktide_staff s
                 join public.clicktide_partner_clients pc on pc.partner_user_id = s.user_id
                where s.user_id = auth.uid()
                  and s.is_active
                  and s.role = 'partner'
                  and pc.client_user_id = client_id
                  and pc.is_active
             )
           )
           and public.clicktide_staff_session_ok()
         );
$$;

create or replace function public.clicktide_can_manage_fulfillment(client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
           exists (
             select 1
               from public.clicktide_staff s
              where s.user_id = auth.uid()
                and s.is_active
                and s.role in ('admin', 'support')
           )
           or exists (
             select 1
               from public.clicktide_staff s
               join public.clicktide_partner_clients pc on pc.partner_user_id = s.user_id
              where s.user_id = auth.uid()
                and s.is_active
                and s.role = 'partner'
                and pc.client_user_id = client_id
                and pc.can_manage_fulfillment
                and pc.is_active
           )
         )
     and public.clicktide_staff_session_ok();
$$;

-- p_capability: 'customers' and 'profile' need can_onboard or can_support, 'campaigns' needs
-- can_manage_campaigns, 'fulfillment' needs can_manage_fulfillment. Admin and support pass.
create or replace function public.clicktide_staff_can_write(p_client uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
           exists (
             select 1
               from public.clicktide_staff s
              where s.user_id = auth.uid()
                and s.is_active
                and s.role in ('admin', 'support')
           )
           or exists (
             select 1
               from public.clicktide_staff s
               join public.clicktide_partner_clients pc on pc.partner_user_id = s.user_id
              where s.user_id = auth.uid()
                and s.is_active
                and s.role = 'partner'
                and pc.client_user_id = p_client
                and pc.is_active
                and case p_capability
                      when 'customers'   then pc.can_onboard or pc.can_support
                      when 'profile'     then pc.can_onboard or pc.can_support
                      when 'campaigns'   then pc.can_manage_campaigns
                      when 'fulfillment' then pc.can_manage_fulfillment
                      else false
                    end
           )
         )
     and public.clicktide_staff_session_ok();
$$;

-- anon keeps EXECUTE on clicktide_is_staff: policies for role public call it (gift_catalog is
-- read logged out), and Postgres checks EXECUTE even when the other OR branch is true.
revoke all on function public.clicktide_is_staff(text[]) from public, anon, authenticated;
grant execute on function public.clicktide_is_staff(text[]) to anon, authenticated, service_role;
revoke all on function public.clicktide_can_access_client(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_can_access_client(uuid) to authenticated, service_role;
revoke all on function public.clicktide_can_manage_fulfillment(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_can_manage_fulfillment(uuid) to service_role;
revoke all on function public.clicktide_staff_can_write(uuid, text) from public, anon, authenticated;
grant execute on function public.clicktide_staff_can_write(uuid, text) to authenticated, service_role;

-- 4. Partner write scope. Restrictive policies are ANDed with the existing permissive ones:
--    owners (auth.uid() = user_id) and admin/support pass exactly as before.
do $$
begin
  drop policy if exists customers_write_scope_insert on public.customers;
  create policy customers_write_scope_insert on public.customers
    as restrictive for insert to authenticated
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'customers'));

  drop policy if exists customers_write_scope_update on public.customers;
  create policy customers_write_scope_update on public.customers
    as restrictive for update to authenticated
    using ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'customers'))
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'customers'));

  drop policy if exists customers_write_scope_delete on public.customers;
  create policy customers_write_scope_delete on public.customers
    as restrictive for delete to authenticated
    using ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'customers'));

  drop policy if exists campaigns_write_scope_insert on public.campaigns;
  create policy campaigns_write_scope_insert on public.campaigns
    as restrictive for insert to authenticated
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'campaigns'));

  drop policy if exists campaigns_write_scope_update on public.campaigns;
  create policy campaigns_write_scope_update on public.campaigns
    as restrictive for update to authenticated
    using ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'campaigns'))
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'campaigns'));

  drop policy if exists campaigns_write_scope_delete on public.campaigns;
  create policy campaigns_write_scope_delete on public.campaigns
    as restrictive for delete to authenticated
    using ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'campaigns'));

  -- No delete policy: 02_api_role_privileges.sql removes DELETE on clicktide from browsers.
  drop policy if exists clicktide_write_scope_insert on public.clicktide;
  create policy clicktide_write_scope_insert on public.clicktide
    as restrictive for insert to authenticated
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'profile'));

  drop policy if exists clicktide_write_scope_update on public.clicktide;
  create policy clicktide_write_scope_update on public.clicktide
    as restrictive for update to authenticated
    using ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'profile'))
    with check ((select auth.uid()) = user_id or public.clicktide_staff_can_write(user_id, 'profile'));

  -- 5. A staff member can only write audit rows as themselves.
  drop policy if exists audit_actor_is_caller on public.clicktide_admin_audit_log;
  create policy audit_actor_is_caller on public.clicktide_admin_audit_log
    as restrictive for insert to authenticated
    with check (actor_user_id = (select auth.uid()));

  -- 6. Profile-change rows (and their code_hash) are for admin/support only. The owner's
  --    dashboard never reads this table; confirm-biz-change uses the service role.
  drop policy if exists bpc_read_staff_only on public.business_profile_changes;
  create policy bpc_read_staff_only on public.business_profile_changes
    as restrictive for select to authenticated
    using ((select public.clicktide_is_staff(array['admin', 'support'])));
end
$$;
