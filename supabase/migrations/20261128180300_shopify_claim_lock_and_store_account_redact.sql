-- Security review of Shopify sign-in v2:
-- M1. Two OAuth callbacks for the same new shop (double-clicked install) could each pass the
--     "already owned" check and link one shop to two accounts. Claims for a shop now take a
--     per-shop advisory lock first, so the second one sees the first owner (already_claimed).
-- M2. shop/redact: also erase the Clicktide account Clicktide made for that store
--     (app_metadata.shopify_shop = shop, signup = 'shopify'): its customers, campaigns, gift
--     shipments and business profile. Wallet rows stay (money ledger; unsent Shopify usage must
--     still be reported). shopify-webhooks then deletes the auth user. Website accounts are
--     untouched (unchanged behaviour). Never runs while the store has an active connection.

CREATE OR REPLACE FUNCTION public.clicktide_shopify_claim(p_token_hash text, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; v_conn record; v_existing uuid; v_shop text;
begin
  select lower(shop_domain) into v_shop from public.shopify_install_claims where token_hash = p_token_hash;
  if v_shop is null then return jsonb_build_object('ok', false, 'error', 'expired_or_used'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('shopify-claim:' || v_shop));
  select * into c from public.shopify_install_claims
   where token_hash = p_token_hash and claimed_at is null and expires_at > now() for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'expired_or_used'); end if;
  select * into v_conn from public.platform_connections where id = c.connection_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'expired_or_used'); end if;
  if v_conn.user_id is not null and v_conn.user_id <> p_user then return jsonb_build_object('ok', false, 'error', 'already_claimed'); end if;
  if exists (select 1 from public.platform_connections o
              where o.platform = 'shopify' and o.id <> v_conn.id and o.is_active
                and o.user_id is not null and o.user_id <> p_user
                and (o.merchant_id = v_conn.merchant_id or lower(o.shop_domain) = lower(v_conn.shop_domain))) then
    update public.platform_connections set is_active = false, access_token = '', refresh_token = null, updated_at = now() where id = v_conn.id;
    update public.shopify_install_claims set claimed_at = now() where token_hash = p_token_hash;
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end if;
  if exists (select 1 from public.platform_connections o
              where o.platform = 'shopify' and o.user_id = p_user and o.is_active and o.id <> v_conn.id
                and o.merchant_id is distinct from v_conn.merchant_id
                and lower(coalesce(o.shop_domain, '')) <> lower(coalesce(v_conn.shop_domain, ''))) then
    return jsonb_build_object('ok', false, 'error', 'other_store',
      'other_shop', (select o.shop_domain from public.platform_connections o
                      where o.platform = 'shopify' and o.user_id = p_user and o.is_active and o.id <> v_conn.id
                      order by o.updated_at desc limit 1));
  end if;
  select id into v_existing from public.platform_connections
   where user_id = p_user and platform = 'shopify' and merchant_id = v_conn.merchant_id and id <> v_conn.id;
  if v_existing is not null then
    delete from public.platform_connections where id = v_conn.id;
    update public.platform_connections set
           access_token = v_conn.access_token, refresh_token = v_conn.refresh_token, token_expires_at = v_conn.token_expires_at,
           scope = v_conn.scope, shop_domain = v_conn.shop_domain, merchant_name = v_conn.merchant_name,
           raw_response = coalesce(v_conn.raw_response, raw_response), is_active = true, revoked_at = null, disconnected_at = null,
           sync_status = null, sync_fail_count = 0, sync_error = null, sync_error_at = null, sync_next_at = now(), updated_at = now()
     where id = v_existing;
  else
    update public.platform_connections set user_id = p_user, sync_next_at = now(), updated_at = now() where id = v_conn.id;
    v_existing := v_conn.id;
  end if;
  update public.shopify_install_claims set claimed_at = now(), claimed_by = p_user where token_hash = p_token_hash;
  return jsonb_build_object('ok', true, 'connection_id', v_existing, 'shop_domain', v_conn.shop_domain);
end $function$;
revoke all on function public.clicktide_shopify_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_claim(text, uuid) to service_role;

-- Returns the ids of the store accounts whose data was erased (shopify-webhooks deletes them in Auth).
CREATE OR REPLACE FUNCTION public.clicktide_shopify_redact_store_accounts(p_shop text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; v_ids bigint[];
begin
  if exists (select 1 from public.platform_connections
              where platform = 'shopify' and is_active and lower(shop_domain) = lower(p_shop)) then
    return '{}'::uuid[];   -- installed again: never erase a live store
  end if;
  select coalesce(array_agg(u.id), '{}') into v_users from auth.users u
   where lower(u.raw_app_meta_data ->> 'shopify_shop') = lower(p_shop)
     and u.raw_app_meta_data ->> 'signup' = 'shopify';
  if cardinality(v_users) = 0 then return v_users; end if;
  select array_agg(id) into v_ids from public.customers where user_id = any(v_users);
  if v_ids is not null then perform public.clicktide_purge_customers(v_ids); end if;
  delete from public.campaigns where user_id = any(v_users);
  delete from public.shipments where user_id = any(v_users);
  delete from public.clicktide where user_id = any(v_users);
  return v_users;
end $function$;
revoke all on function public.clicktide_shopify_redact_store_accounts(text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_redact_store_accounts(text) to service_role;
