-- Security review S1: shop/redact must erase everything a store's own Clicktide account holds,
-- not only what cascades from the auth user. Added: the user_id-keyed tables with no foreign key
-- (registration details, owner texts, support chats, suppressions, AI suggestions, templates,
-- products, profile changes, funnel events, order ledger, gift claims, pending OAuth, and
-- sms_messages / message_events rows not tied to a customer). Kept on purpose (money and
-- anti-abuse ledgers): wallet, wallet_reversals, shopify_usage_limits, stripe_trial_claims,
-- billing_checkout_*, stripe_subscription_sync. The brand logo (storage logos/u/<uid>/) is removed
-- by shopify-webhooks through the storage API before the auth user is deleted.
CREATE OR REPLACE FUNCTION public.clicktide_shopify_redact_store_accounts(p_shop text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_users uuid[]; v_ids bigint[]; t text;
begin
  if exists (select 1 from public.platform_connections
              where platform = 'shopify' and is_active and lower(shop_domain) = lower(p_shop)) then
    return '{}'::uuid[];   -- installed again: never erase a live store
  end if;
  select coalesce(array_agg(u.id), '{}') into v_users from auth.users u
   where lower(u.raw_app_meta_data ->> 'shopify_shop') = lower(p_shop)
     and u.raw_app_meta_data ->> 'signup' = 'shopify';
  if cardinality(v_users) = 0 then return v_users; end if;
  -- children first (sms_messages references campaigns and customers)
  foreach t in array array['message_events', 'sms_messages', 'owner_sms_log', 'a2p_registrations', 'support_chats',
                           'email_suppressions', 'ai_suggestions', 'email_templates', 'brand_products',
                           'business_profile_changes', 'funnel_events', 'pos_order_ledger', 'gift_send_claims',
                           'oauth_pending', 'alerts', 'survey_responses'] loop
    execute format('delete from public.%I where user_id = any($1)', t) using v_users;
  end loop;
  select array_agg(id) into v_ids from public.customers where user_id = any(v_users);
  if v_ids is not null then perform public.clicktide_purge_customers(v_ids); end if;
  delete from public.campaigns where user_id = any(v_users);
  delete from public.shipments where user_id = any(v_users);
  delete from public.clicktide where user_id = any(v_users);
  return v_users;
end $function$;
revoke all on function public.clicktide_shopify_redact_store_accounts(text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_redact_store_accounts(text) to service_role;
