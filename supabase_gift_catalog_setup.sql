-- Clicktide gift catalog
-- Businesses see these as Clicktide gift options. Printify details stay internal.

create table if not exists public.gift_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subtitle text,
  category text not null default 'general',
  image_url text,
  estimated_cost numeric not null default 0,
  currency text not null default 'USD',
  printify_product_id text,
  printify_variant_id integer,
  printify_blueprint_id text,
  print_provider_id text,
  is_active boolean not null default true,
  is_featured boolean not null default false,
  source text not null default 'manual',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists gift_catalog_printify_variant_unique
  on public.gift_catalog (printify_product_id, printify_variant_id)
  where printify_product_id is not null and printify_variant_id is not null;

alter table public.gift_catalog enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gift_catalog'
      and policyname = 'gift_catalog_active_read'
  ) then
    create policy gift_catalog_active_read
      on public.gift_catalog
      for select
      using (
        is_active
        or public.clicktide_is_staff(array['admin','support','partner'])
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gift_catalog'
      and policyname = 'gift_catalog_staff_write'
  ) then
    create policy gift_catalog_staff_write
      on public.gift_catalog
      for all
      using (public.clicktide_is_staff(array['admin','support']))
      with check (public.clicktide_is_staff(array['admin','support']));
  end if;
end $$;

grant select on public.gift_catalog to authenticated;
grant insert, update, delete on public.gift_catalog to authenticated;

alter table public.campaigns
  add column if not exists gift_catalog_id uuid references public.gift_catalog(id),
  add column if not exists printify_product_id text,
  add column if not exists printify_variant_id integer,
  add column if not exists gift_image_url text;

insert into public.gift_catalog (
  name,
  subtitle,
  category,
  estimated_cost,
  printify_product_id,
  printify_variant_id,
  is_active,
  is_featured,
  source
) values
  ('Unisex T-Shirt', 'Bella+Canvas 3001', 'apparel', 18, '5d15ca528cd8f30117000056', 17887, true, true, 'seed'),
  ('Premium T-Shirt', 'Next Level 3600', 'apparel', 22, '5d15ca528cd8f30117000056', 17888, true, false, 'seed'),
  ('Snapback Hat', 'Classic structured', 'accessories', 24, '5d15ca528cd8f3011700006b', 18105, true, true, 'seed'),
  ('Dad Hat', 'Low profile cotton', 'accessories', 20, '5d15ca528cd8f30117000067', 18098, true, false, 'seed'),
  ('11oz Mug', 'Ceramic white glossy', 'drinkware', 14, '64f1f3719b3bc6bb9a0f7a34', 72588, true, true, 'seed'),
  ('20oz Tumbler', 'Stainless steel', 'drinkware', 28, '5d15ca528cd8f30117000053', 17876, true, true, 'seed'),
  ('Tote Bag', 'Heavy cotton canvas', 'bags', 16, '5d15ca528cd8f30117000058', 17896, true, true, 'seed'),
  ('Drawstring Bag', 'Lightweight polyester', 'bags', 18, '5d15ca528cd8f30117000057', 17892, true, false, 'seed'),
  ('Spiral Notebook', 'A5 matte cover', 'stationery', 17, '5d15ca528cd8f30117000065', 18090, true, true, 'seed'),
  ('Pen + Notebook Set', 'Premium combo', 'stationery', 24, '5d15ca528cd8f30117000064', 18086, true, false, 'seed'),
  ('Pullover Hoodie', 'Gildan 18500', 'apparel', 38, '5d15ca528cd8f3011700005a', 17904, true, true, 'seed'),
  ('Tank Top', 'Bella+Canvas 3480', 'apparel', 20, '5d15ca528cd8f3011700005e', 17920, true, false, 'seed')
on conflict do nothing;
