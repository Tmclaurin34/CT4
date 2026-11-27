-- Sign-in from the Shopify admin for a store's own Clicktide account (security review):
-- shopify-app / shopify-oauth-callback redirect to goclicktide.com/#ct_sso=<code> (fragment, so the
-- code never reaches a server log); the page POSTs it to shopify-sso, which takes it here and only
-- then creates the session server-side. Codes: single use, 60 seconds, stored hashed, bound to the
-- account and the shop. Minted and taken only for a non-staff account with an ACTIVE connection to
-- that shop (shopify-sso also re-checks app_metadata.shopify_shop through the admin API).
create table if not exists public.shopify_sso_codes (
  code_hash text primary key,
  user_id uuid not null,
  shop_domain text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.shopify_sso_codes enable row level security;
revoke all on public.shopify_sso_codes from public, anon, authenticated;
grant select, insert, delete on public.shopify_sso_codes to service_role;

create or replace function public.clicktide_shopify_sso_eligible(p_user uuid, p_shop text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and not exists (select 1 from public.clicktide_staff s where s.user_id = p_user and coalesce(s.is_active, true))
     and exists (select 1 from public.platform_connections c
                  where c.user_id = p_user and c.platform = 'shopify' and c.is_active
                    and coalesce(c.access_token, '') <> '' and lower(c.shop_domain) = lower(p_shop));
$$;

create or replace function public.clicktide_shopify_sso_mint(p_user uuid, p_shop text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not public.clicktide_shopify_sso_eligible(p_user, p_shop) then return null; end if;
  delete from public.shopify_sso_codes where expires_at < now() - interval '1 hour';
  v_code := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.shopify_sso_codes (code_hash, user_id, shop_domain, expires_at)
  values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), p_user, lower(p_shop), now() + interval '60 seconds');
  return v_code;
end $$;

-- Single use: the row is deleted as it is read. Eligibility is checked again at take time.
create or replace function public.clicktide_shopify_sso_take(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  delete from public.shopify_sso_codes
   where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
  returning user_id, shop_domain, expires_at into r;
  if not found or r.expires_at < now() then return jsonb_build_object('ok', false); end if;
  if not public.clicktide_shopify_sso_eligible(r.user_id, r.shop_domain) then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'user_id', r.user_id, 'shop', r.shop_domain);
end $$;

revoke all on function public.clicktide_shopify_sso_eligible(uuid, text) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_sso_mint(uuid, text) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_sso_take(text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_sso_eligible(uuid, text) to service_role;
grant execute on function public.clicktide_shopify_sso_mint(uuid, text) to service_role;
grant execute on function public.clicktide_shopify_sso_take(text) to service_role;
