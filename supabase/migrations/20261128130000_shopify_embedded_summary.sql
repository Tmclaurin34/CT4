-- Summary shown on Clicktide's embedded page inside the Shopify admin (shopify-embedded fn).
-- Server-only: the function is called with the service role after the Shopify session token
-- has been verified and the shop mapped to its Clicktide business.
create or replace function public.clicktide_shopify_embedded_summary(p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'business_name', (select business_name from public.clicktide where user_id = p_user limit 1),
    'plan', (select plan from public.clicktide where user_id = p_user limit 1),
    'plan_status', (select stripe_subscription_status from public.clicktide where user_id = p_user limit 1),
    'customers', (select count(*) from public.customers where user_id = p_user),
    'healthy', (select count(*) from public.customer_rhythm where user_id = p_user and status = 'healthy'),
    'drifting', (select count(*) from public.customer_rhythm where user_id = p_user and status = 'drifting'),
    'at_risk', (select count(*) from public.customer_rhythm where user_id = p_user and status = 'at_risk'),
    'recovered', (select count(*) from public.customer_rhythm where user_id = p_user and status = 'recovered'),
    'slipping_spend', (select coalesce(round(sum(c.total_spent)::numeric, 0), 0) from public.customer_rhythm r
                        join public.customers c on c.id = r.customer_id
                       where r.user_id = p_user and r.status in ('drifting', 'at_risk')),
    'active_campaigns', (select count(*) from public.campaigns where user_id = p_user and status = 'active'),
    'last_synced_at', (select max(last_synced_at) from public.platform_connections where user_id = p_user and platform = 'shopify')
  );
$$;
revoke all on function public.clicktide_shopify_embedded_summary(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_embedded_summary(uuid) to service_role;
