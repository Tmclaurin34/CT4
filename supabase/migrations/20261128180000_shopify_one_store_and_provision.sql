-- Shopify review prep (non-embedded app):
-- 1. One Shopify store per Clicktide account. Claiming a second store used to leave two active
--    connections on one business, and billing then flipped between the two shops' plans.
--    Now the claim is refused (and NOT consumed, so the merchant can sign in with another
--    account or let Clicktide set one up for the store).
-- 2. clicktide_shopify_claim_info: what shopify-claim needs to decide between "set up a new
--    Clicktide account for this store" and "this store already belongs to an account".

CREATE OR REPLACE FUNCTION public.clicktide_shopify_claim(p_token_hash text, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; v_conn record; v_existing uuid;
begin
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
  -- One store per account: this account already has a DIFFERENT active Shopify store.
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
  if v_existing is not null then  -- reinstall: move the new grant onto the business's existing row
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

-- A valid, unused claim: its shop, and the Clicktide account that already owns this store (the
-- most recent connection for the same shop id or domain that has an owner), if any.
CREATE OR REPLACE FUNCTION public.clicktide_shopify_claim_info(p_token_hash text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when c.token_hash is null then jsonb_build_object('ok', false)
  else jsonb_build_object(
    'ok', true,
    'shop_domain', lower(v.shop_domain),
    'merchant_id', v.merchant_id,
    'merchant_name', v.merchant_name,
    'owner', (select o.user_id from public.platform_connections o
               where o.platform = 'shopify' and o.user_id is not null
                 and (o.merchant_id = v.merchant_id or lower(o.shop_domain) = lower(v.shop_domain))
               order by o.is_active desc, o.updated_at desc limit 1))
  end
  from (select 1) one
  left join public.shopify_install_claims c on c.token_hash = p_token_hash and c.claimed_at is null and c.expires_at > now()
  left join public.platform_connections v on v.id = c.connection_id;
$function$;
revoke all on function public.clicktide_shopify_claim_info(text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_claim_info(text) to service_role;
