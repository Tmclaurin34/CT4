-- Opening Clicktide from the Shopify admin signs a store-provisioned account in. Each signed
-- launch URL may do that once: its hmac is recorded here (server-only, pruned after a day).
create table if not exists public.shopify_launch_nonces (
  hmac text primary key,
  shop_domain text not null,
  used_at timestamptz not null default now()
);
alter table public.shopify_launch_nonces enable row level security;
revoke all on public.shopify_launch_nonces from public, anon, authenticated;
grant select, insert, delete on public.shopify_launch_nonces to service_role;

-- True the first time a launch hmac is seen (and records it); false on any replay.
create or replace function public.clicktide_shopify_launch_once(p_hmac text, p_shop text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.shopify_launch_nonces where used_at < now() - interval '1 day';
  insert into public.shopify_launch_nonces (hmac, shop_domain) values (p_hmac, lower(p_shop)) on conflict (hmac) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.clicktide_shopify_launch_once(text, text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_launch_once(text, text) to service_role;
