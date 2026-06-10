-- Clicktide browser app compatibility setup.
-- Additive only: creates missing columns and user-scoped RLS policies.

alter table public.clicktide
  add column if not exists contact_name text,
  add column if not exists business_phone text,
  add column if not exists business_email text;

alter table public.campaigns
  add column if not exists campaign_type text,
  add column if not exists message text,
  add column if not exists delay_days integer default 0,
  add column if not exists cancel_on_refund boolean default true,
  add column if not exists min_spend real default 0,
  add column if not exists cooldown_days integer default 30,
  add column if not exists product_trigger text,
  add column if not exists min_order_val real default 0;

alter table public.wallet
  add column if not exists "desc" text,
  add column if not exists amount real default 0;

alter table public.clicktide enable row level security;
alter table public.customers enable row level security;
alter table public.campaigns enable row level security;
alter table public.shipments enable row level security;
alter table public.wallet enable row level security;
alter table public.oauth_states enable row level security;
alter table public.platform_connections enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clicktide' and policyname = 'clicktide_user_all') then
    create policy clicktide_user_all on public.clicktide
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'customers_user_all') then
    create policy customers_user_all on public.customers
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'campaigns' and policyname = 'campaigns_user_all') then
    create policy campaigns_user_all on public.campaigns
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shipments' and policyname = 'shipments_user_all') then
    create policy shipments_user_all on public.shipments
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wallet' and policyname = 'wallet_user_all') then
    create policy wallet_user_all on public.wallet
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'oauth_states' and policyname = 'oauth_states_user_all') then
    create policy oauth_states_user_all on public.oauth_states
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'platform_connections' and policyname = 'platform_connections_user_all') then
    create policy platform_connections_user_all on public.platform_connections
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

