-- A website-first business (pays through Stripe) that connects Shopify keeps Stripe. If it
-- later actually subscribes through Shopify (a live Shopify plan), it switches to Shopify
-- billing here, and the caller cancels its Stripe subscription at period end so it never
-- pays twice. A pending/declined/cancelled Shopify subscription never touches a Stripe payer.
-- Durable queue of Stripe subscriptions to stop at period end (retried until Stripe confirms).
create table if not exists public.shopify_stripe_switch (
  stripe_subscription_id text primary key,
  user_id uuid not null,
  requested_at timestamptz not null default now(),
  done_at timestamptz,
  attempts integer not null default 0,
  last_result text
);
alter table public.shopify_stripe_switch enable row level security;
revoke all on public.shopify_stripe_switch from public, anon, authenticated;
grant select, insert, update on public.shopify_stripe_switch to service_role;

create or replace function public.clicktide_shopify_apply_entitlement(
  p_shop text, p_plan text, p_status text, p_period_end timestamptz, p_sub_id text, p_raw_status text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r record; v_applied int := 0; v_conflicts int := 0; v_cancel jsonb := '[]'::jsonb;
  v_live boolean := p_plan is not null and p_status in ('active', 'trialing');
  v_stripe boolean;
begin
  if p_plan is not null and p_plan not in ('Local','Growth','Scale') then raise exception 'bad plan %', p_plan; end if;
  perform set_config('clicktide.billing_writer', 'shopify', true);
  for r in select b.user_id, b.billing_provider, b.stripe_subscription_id, b.stripe_subscription_status
             from public.clicktide b
            where b.user_id in (select user_id from public.platform_connections
                                 where platform = 'shopify' and lower(shop_domain) = lower(p_shop) and is_active and user_id is not null)
            for update of b
  loop
    v_stripe := r.billing_provider = 'stripe'
       or (r.billing_provider is null and r.stripe_subscription_id is not null
           and lower(coalesce(r.stripe_subscription_status, '')) in ('active','trialing','past_due'));
    if v_stripe and not v_live then
      v_conflicts := v_conflicts + 1;  -- still paying through Stripe, no live Shopify plan: leave it alone
      continue;
    end if;
    if v_stripe and r.stripe_subscription_id is not null then
      v_cancel := v_cancel || jsonb_build_object('user_id', r.user_id, 'stripe_subscription_id', r.stripe_subscription_id);
      insert into public.shopify_stripe_switch (stripe_subscription_id, user_id)
      values (r.stripe_subscription_id, r.user_id) on conflict (stripe_subscription_id) do nothing;
    end if;
    update public.clicktide set
      billing_provider = 'shopify', shopify_shop_domain = lower(p_shop),
      shopify_subscription_id = p_sub_id, shopify_subscription_status = p_raw_status,
      plan = coalesce(p_plan, plan), stripe_subscription_status = p_status, stripe_current_period_end = p_period_end
     where user_id = r.user_id;
    v_applied := v_applied + 1;
  end loop;
  return jsonb_build_object('applied', v_applied, 'stripe_conflicts', v_conflicts, 'stripe_cancel', v_cancel);
end $$;

revoke all on function public.clicktide_shopify_apply_entitlement(text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_apply_entitlement(text, text, text, timestamptz, text, text) to service_role;
