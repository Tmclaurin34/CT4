-- Clicktide back office access model.
-- Owners/admins can support every client account.
-- Partners can support only client accounts assigned to them.

create table if not exists public.clicktide_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'support', 'partner')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.clicktide_partner_clients (
  partner_user_id uuid not null references auth.users(id) on delete cascade,
  client_user_id uuid not null references auth.users(id) on delete cascade,
  can_onboard boolean not null default true,
  can_support boolean not null default true,
  can_manage_campaigns boolean not null default true,
  can_manage_fulfillment boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (partner_user_id, client_user_id)
);

create table if not exists public.clicktide_admin_audit_log (
  id bigserial primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  client_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_table text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.clicktide_staff enable row level security;
alter table public.clicktide_partner_clients enable row level security;
alter table public.clicktide_admin_audit_log enable row level security;

create or replace function public.clicktide_is_staff(required_roles text[] default array['admin','support','partner'])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.clicktide_staff s
    where s.user_id = auth.uid()
      and s.is_active
      and s.role = any(required_roles)
  );
$$;

create or replace function public.clicktide_can_access_client(client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() = client_id
    or exists (
      select 1
      from public.clicktide_staff s
      where s.user_id = auth.uid()
        and s.is_active
        and s.role in ('admin', 'support')
    )
    or exists (
      select 1
      from public.clicktide_staff s
      join public.clicktide_partner_clients pc
        on pc.partner_user_id = s.user_id
      where s.user_id = auth.uid()
        and s.is_active
        and s.role = 'partner'
        and pc.client_user_id = client_id
        and pc.is_active
    );
$$;

create or replace function public.clicktide_can_manage_fulfillment(client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
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
      join public.clicktide_partner_clients pc
        on pc.partner_user_id = s.user_id
      where s.user_id = auth.uid()
        and s.is_active
        and s.role = 'partner'
        and pc.client_user_id = client_id
        and pc.can_manage_fulfillment
        and pc.is_active
    );
$$;

revoke all on function public.clicktide_is_staff(text[]) from public;
revoke all on function public.clicktide_can_access_client(uuid) from public;
revoke all on function public.clicktide_can_manage_fulfillment(uuid) from public;
grant execute on function public.clicktide_is_staff(text[]) to authenticated;
grant execute on function public.clicktide_can_access_client(uuid) to authenticated;
grant execute on function public.clicktide_can_manage_fulfillment(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_staff' and policyname='staff_admin_read') then
    create policy staff_admin_read on public.clicktide_staff
      for select using (public.clicktide_is_staff(array['admin','support']));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_staff' and policyname='staff_admin_write') then
    create policy staff_admin_write on public.clicktide_staff
      for all using (public.clicktide_is_staff(array['admin']))
      with check (public.clicktide_is_staff(array['admin']));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_partner_clients' and policyname='partner_clients_staff_read') then
    create policy partner_clients_staff_read on public.clicktide_partner_clients
      for select using (
        public.clicktide_is_staff(array['admin','support'])
        or partner_user_id = auth.uid()
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_partner_clients' and policyname='partner_clients_admin_write') then
    create policy partner_clients_admin_write on public.clicktide_partner_clients
      for all using (public.clicktide_is_staff(array['admin','support']))
      with check (public.clicktide_is_staff(array['admin','support']));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_admin_audit_log' and policyname='audit_staff_read') then
    create policy audit_staff_read on public.clicktide_admin_audit_log
      for select using (public.clicktide_is_staff(array['admin','support']));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clicktide_admin_audit_log' and policyname='audit_staff_insert') then
    create policy audit_staff_insert on public.clicktide_admin_audit_log
      for insert with check (public.clicktide_is_staff(array['admin','support','partner']));
  end if;
end $$;

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'clicktide',
    'customers',
    'campaigns',
    'shipments',
    'wallet',
    'oauth_states',
    'platform_connections'
  ]
  loop
    policy_name := table_name || '_staff_client_access';
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = policy_name
    ) then
      execute format(
        'create policy %I on public.%I for all using (public.clicktide_can_access_client(user_id)) with check (public.clicktide_can_access_client(user_id))',
        policy_name,
        table_name
      );
    end if;
  end loop;
end $$;

-- After this file is applied, make your Clicktide login an admin with:
--
-- insert into public.clicktide_staff (user_id, role)
-- select id, 'admin'
-- from auth.users
-- where email = 'YOUR-CLICKTIDE-LOGIN-EMAIL'
-- on conflict (user_id) do update set role = excluded.role, is_active = true;
--
-- Add a partner and assign one client with:
--
-- insert into public.clicktide_staff (user_id, role)
-- select id, 'partner'
-- from auth.users
-- where email = 'PARTNER-LOGIN-EMAIL'
-- on conflict (user_id) do update set role = excluded.role, is_active = true;
--
-- insert into public.clicktide_partner_clients (partner_user_id, client_user_id)
-- select partner.id, client.id
-- from auth.users partner
-- cross join auth.users client
-- where partner.email = 'PARTNER-LOGIN-EMAIL'
--   and client.email = 'CLIENT-LOGIN-EMAIL'
-- on conflict (partner_user_id, client_user_id) do update set is_active = true;
