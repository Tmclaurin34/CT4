-- A Shopify store already connected (active) to one Clicktide business can't be
-- claimed by another through the install-from-Shopify path, matching the
-- merchant_in_use rule of the normal connect flow. The stray unclaimed row is
-- deactivated and its token wiped; the claim is consumed.
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
  select id into v_existing from public.platform_connections
   where user_id = p_user and platform = 'shopify' and merchant_id = v_conn.merchant_id and id <> v_conn.id;
  if v_existing is not null then  -- reinstall: refresh the business's existing row
    update public.platform_connections set access_token = v_conn.access_token, scope = v_conn.scope, shop_domain = v_conn.shop_domain,
           merchant_name = v_conn.merchant_name, is_active = true, updated_at = now() where id = v_existing;
    delete from public.platform_connections where id = v_conn.id;
  else
    update public.platform_connections set user_id = p_user, updated_at = now() where id = v_conn.id;
    v_existing := v_conn.id;
  end if;
  update public.shopify_install_claims set claimed_at = now(), claimed_by = p_user where token_hash = p_token_hash;
  return jsonb_build_object('ok', true, 'connection_id', v_existing, 'shop_domain', v_conn.shop_domain);
end $function$;
revoke all on function public.clicktide_shopify_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_claim(text, uuid) to service_role;
