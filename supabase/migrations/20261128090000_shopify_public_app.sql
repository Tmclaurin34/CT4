-- Shopify public app: compliance (GDPR) webhooks, install claims, Shopify billing.
-- NOT APPLIED. Needs the owner's OK. Test first (rolled back):
--   supabase/tests/run_shopify_tests.sh
-- Everything here is server-only: no anon/authenticated access to the new
-- tables or functions.

-- 1) Every Shopify webhook we receive (idempotency + audit trail for reviewers).
create table if not exists public.shopify_webhook_events (
  id            bigserial primary key,
  webhook_id    text unique,                 -- X-Shopify-Webhook-Id (Shopify retries reuse it)
  topic         text not null,
  shop_domain   text not null,
  status        text not null default 'received' check (status in ('received','processed','failed','ignored')),
  payload       jsonb,                       -- kept only while needed; redact topics are scrubbed after processing
  result        jsonb,
  attempts      int not null default 0,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  due_by        timestamptz not null default now() + interval '30 days'  -- Shopify's deadline
);
create index if not exists shopify_webhook_events_shop_idx on public.shopify_webhook_events (lower(shop_domain));
create index if not exists shopify_webhook_events_pending_idx on public.shopify_webhook_events (status) where status in ('received','failed');
alter table public.shopify_webhook_events enable row level security;
revoke all on public.shopify_webhook_events from anon, authenticated;

-- 2) A Shopify-initiated install has no Clicktide login yet: the connection is
-- stored unclaimed (user_id null) and the merchant gets a one-time claim token
-- (only its SHA-256 is stored) to attach it to their account after sign-in.
create table if not exists public.shopify_install_claims (
  token_hash     text primary key,
  connection_id  uuid not null references public.platform_connections(id) on delete cascade,
  shop_domain    text not null,
  expires_at     timestamptz not null default now() + interval '1 hour',
  claimed_at     timestamptz,
  claimed_by     uuid
);
alter table public.shopify_install_claims enable row level security;
revoke all on public.shopify_install_claims from anon, authenticated;

create index if not exists platform_connections_shop_idx
  on public.platform_connections (lower(shop_domain)) where platform = 'shopify';

-- 3) Shopify billing columns on the business row. Entitlement stays in the
-- columns every paywall reader already uses (plan + stripe_subscription_status,
-- 'active'/'trialing'/'past_due' = live), so nothing else has to change.
alter table public.clicktide
  add column if not exists billing_provider text check (billing_provider in ('stripe','shopify')),
  add column if not exists shopify_shop_domain text,
  add column if not exists shopify_subscription_id text,
  add column if not exists shopify_subscription_status text;

-- Guard: browsers can never write the new columns, and once a business is billed
-- by Shopify only the Shopify path (clicktide_shopify_apply_entitlement, which
-- sets clicktide.billing_writer) may change its entitlement — a stray Stripe
-- event can't downgrade or upgrade it. Complements clicktide_guard_protected_columns.
create or replace function public.clicktide_guard_shopify_billing()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role   text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_browser boolean;
begin
  v_browser := v_role in ('anon', 'authenticated')
               and not (v_role = 'authenticated' and public.clicktide_is_staff(array['admin', 'support']));
  if tg_op = 'INSERT' then
    if v_browser then
      new.billing_provider := null; new.shopify_shop_domain := null;
      new.shopify_subscription_id := null; new.shopify_subscription_status := null;
    end if;
    return new;
  end if;
  if v_browser then
    new.billing_provider := old.billing_provider; new.shopify_shop_domain := old.shopify_shop_domain;
    new.shopify_subscription_id := old.shopify_subscription_id; new.shopify_subscription_status := old.shopify_subscription_status;
    return new;
  end if;
  if v_role = 'service_role' and old.billing_provider = 'shopify'
     and coalesce(current_setting('clicktide.billing_writer', true), '') <> 'shopify'
     and (new.plan is distinct from old.plan
          or new.stripe_subscription_status is distinct from old.stripe_subscription_status
          or new.stripe_current_period_end is distinct from old.stripe_current_period_end
          or new.billing_provider is distinct from old.billing_provider) then
    raise log 'clicktide_guard_shopify_billing: ignored non-Shopify billing write on Shopify-billed business %', old.user_id;
    new.plan := old.plan;
    new.stripe_subscription_status := old.stripe_subscription_status;
    new.stripe_current_period_end := old.stripe_current_period_end;
    new.billing_provider := old.billing_provider;
  end if;
  return new;
end $$;
drop trigger if exists clicktide_guard_shopify_billing on public.clicktide;
create trigger clicktide_guard_shopify_billing before insert or update on public.clicktide
  for each row execute function public.clicktide_guard_shopify_billing();

-- Helper: last 10 digits of a phone.
create or replace function public.clicktide_phone10(p text)
returns text language sql immutable set search_path to '' as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '')
$$;

-- Remove one set of customers' personal data everywhere it lives.
-- Financial/ledger rows (shipments, sms_messages) are kept but anonymised so
-- wallet and usage totals stay correct; everything else is deleted. Rows in
-- campaign_sends, customer_visits, pos_transactions_seen, customer_rhythm and
-- customer_status_events cascade from customers.
create or replace function public.clicktide_purge_customers(p_ids bigint[])
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  update public.shipments set customer_name = 'Redacted', customer_email = null, address = null where customer_id = any(p_ids);
  update public.sms_messages set to_phone = 'redacted', body = '[redacted]' where customer_id = any(p_ids);
  delete from public.message_events where customer_id = any(p_ids);
  delete from public.survey_responses where customer_id = any(p_ids);
  delete from public.alerts where customer_id = any(p_ids);
  delete from public.customers where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- customers/redact: delete this shopper from every Clicktide business connected
-- to the shop (active or not — the request can arrive after uninstall).
create or replace function public.clicktide_shopify_redact_customer(p_shop text, p_email text, p_phone text, p_order_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_users uuid[]; v_ids bigint[]; v_email text := lower(btrim(coalesce(p_email, ''))); v_p10 text := public.clicktide_phone10(p_phone);
  v_deleted int; v_orders int;
begin
  select array_agg(distinct user_id) into v_users from public.platform_connections
   where platform = 'shopify' and lower(shop_domain) = lower(p_shop) and user_id is not null;
  if v_users is null then return jsonb_build_object('businesses', 0, 'customers_deleted', 0); end if;
  -- shopper matched by email or phone, or by an order Shopify listed
  select array_agg(distinct c.id) into v_ids from public.customers c
   where c.user_id = any(v_users)
     and ((v_email <> '' and lower(c.email) = v_email)
          or (length(coalesce(v_p10, '')) = 10 and public.clicktide_phone10(c.phone) = v_p10)
          or exists (select 1 from public.pos_transactions_seen s
                      where s.customer_id = c.id and s.source = 'shopify' and s.source_txn_id = any(coalesce(p_order_ids, '{}'))));
  update public.shipments set customer_name = 'Redacted', customer_email = null, address = null
   where user_id = any(v_users) and v_email <> '' and lower(customer_email) = v_email;
  delete from public.pos_transactions_seen where user_id = any(v_users) and source = 'shopify' and source_txn_id = any(coalesce(p_order_ids, '{}'));
  get diagnostics v_orders = row_count;
  v_deleted := public.clicktide_purge_customers(v_ids);
  return jsonb_build_object('businesses', cardinality(v_users), 'customers_deleted', v_deleted, 'order_rows_deleted', v_orders);
end $$;

-- shop/redact (48h after uninstall): delete what came from this shop.
-- Customers known ONLY through Shopify are deleted; customers the business also
-- knows from another source (Square, check-in, CSV...) keep their record but
-- lose their Shopify order rows. The connection (and token) is deleted, free
-- audits run on this shop are deleted, and Shopify billing is ended.
create or replace function public.clicktide_shopify_redact_shop(p_shop text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_users uuid[]; v_ids bigint[]; v_deleted int; v_rows int; v_conns int;
begin
  select array_agg(distinct user_id) into v_users from public.platform_connections
   where platform = 'shopify' and lower(shop_domain) = lower(p_shop) and user_id is not null;
  if v_users is not null then
    select array_agg(c.id) into v_ids from public.customers c
     where c.user_id = any(v_users)
       and exists (select 1 from public.pos_transactions_seen s where s.customer_id = c.id and s.source = 'shopify')
       and not exists (select 1 from public.pos_transactions_seen s where s.customer_id = c.id and s.source <> 'shopify')
       and not exists (select 1 from public.customer_visits v where v.customer_id = c.id and not (v.sources <@ array['shopify']::text[]));
    v_deleted := public.clicktide_purge_customers(v_ids);
    delete from public.pos_transactions_seen where user_id = any(v_users) and source = 'shopify';
    get diagnostics v_rows = row_count;
    delete from public.pos_audits where user_id = any(v_users) and platform = 'shopify';
    perform set_config('clicktide.billing_writer', 'shopify', true);
    update public.clicktide set stripe_subscription_status = 'canceled', shopify_subscription_status = 'CANCELLED'
     where user_id = any(v_users) and billing_provider = 'shopify' and lower(shopify_shop_domain) = lower(p_shop);
  end if;
  delete from public.platform_connections where platform = 'shopify' and lower(shop_domain) = lower(p_shop);
  get diagnostics v_conns = row_count;
  update public.shopify_webhook_events set payload = null where lower(shop_domain) = lower(p_shop) and topic <> 'shop/redact';
  return jsonb_build_object('businesses', coalesce(cardinality(v_users), 0), 'customers_deleted', coalesce(v_deleted, 0),
                            'shopify_order_rows_deleted', coalesce(v_rows, 0), 'connections_deleted', v_conns);
end $$;

-- customers/data_request: what Clicktide holds about this shopper, for support
-- to send to the merchant (Shopify asks the app to give it to the merchant).
create or replace function public.clicktide_shopify_customer_data(p_shop text, p_email text, p_phone text)
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', c.name, 'email', c.email, 'phone', c.phone,
           'address', concat_ws(', ', c.address, c.city, c.state, c.zip),
           'visits', c.visits, 'total_spent', c.total_spent, 'first_order_at', c.first_order_at, 'last_visit_at', c.last_visit_at,
           'sms_consent', c.sms_consent, 'email_unsubscribed_at', c.email_unsubscribed_at,
           'messages_sent', (select count(*) from public.campaign_sends s where s.customer_id = c.id),
           'shopify_orders', (select coalesce(jsonb_agg(t.source_txn_id), '[]') from public.pos_transactions_seen t where t.customer_id = c.id and t.source = 'shopify'))), '[]'::jsonb)
    from public.customers c
   where c.user_id in (select user_id from public.platform_connections where platform = 'shopify' and lower(shop_domain) = lower(p_shop) and user_id is not null)
     and ((btrim(coalesce(p_email, '')) <> '' and lower(c.email) = lower(btrim(p_email)))
          or (length(coalesce(public.clicktide_phone10(p_phone), '')) = 10 and public.clicktide_phone10(c.phone) = public.clicktide_phone10(p_phone)))
$$;

-- Shopify billing: apply the subscription Clicktide just read from Shopify.
-- p_status is already mapped to the Stripe-style value the paywall reads.
-- Never overrides a business that pays through Stripe.
create or replace function public.clicktide_shopify_apply_entitlement(
  p_shop text, p_plan text, p_status text, p_period_end timestamptz, p_sub_id text, p_raw_status text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r record; v_applied int := 0; v_conflicts int := 0;
begin
  if p_plan is not null and p_plan not in ('Local','Growth','Scale') then raise exception 'bad plan %', p_plan; end if;
  perform set_config('clicktide.billing_writer', 'shopify', true);
  for r in select b.user_id, b.billing_provider, b.stripe_subscription_id, b.stripe_subscription_status
             from public.clicktide b
            where b.user_id in (select user_id from public.platform_connections
                                 where platform = 'shopify' and lower(shop_domain) = lower(p_shop) and is_active and user_id is not null)
  loop
    if r.billing_provider = 'stripe'
       or (r.billing_provider is null and r.stripe_subscription_id is not null
           and lower(coalesce(r.stripe_subscription_status, '')) in ('active','trialing','past_due')) then
      v_conflicts := v_conflicts + 1;  -- already paying through Stripe: leave it alone
      continue;
    end if;
    update public.clicktide set
      billing_provider = 'shopify', shopify_shop_domain = lower(p_shop),
      shopify_subscription_id = p_sub_id, shopify_subscription_status = p_raw_status,
      plan = coalesce(p_plan, plan), stripe_subscription_status = p_status, stripe_current_period_end = p_period_end
     where user_id = r.user_id;
    v_applied := v_applied + 1;
  end loop;
  return jsonb_build_object('applied', v_applied, 'stripe_conflicts', v_conflicts);
end $$;

-- Attach an unclaimed Shopify install to the signed-in business (single use).
create or replace function public.clicktide_shopify_claim(p_token_hash text, p_user uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare c record; v_conn record; v_existing uuid;
begin
  select * into c from public.shopify_install_claims
   where token_hash = p_token_hash and claimed_at is null and expires_at > now() for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'expired_or_used'); end if;
  select * into v_conn from public.platform_connections where id = c.connection_id;
  if v_conn.user_id is not null and v_conn.user_id <> p_user then return jsonb_build_object('ok', false, 'error', 'already_claimed'); end if;
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
end $$;

revoke all on function public.clicktide_purge_customers(bigint[]) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_redact_customer(text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_redact_shop(text) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_customer_data(text, text, text) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_apply_entitlement(text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_claim(text, uuid) from public, anon, authenticated;
revoke all on function public.clicktide_guard_shopify_billing() from public, anon, authenticated;
grant execute on function public.clicktide_purge_customers(bigint[]) to service_role;
grant execute on function public.clicktide_shopify_redact_customer(text, text, text, text[]) to service_role;
grant execute on function public.clicktide_shopify_redact_shop(text) to service_role;
grant execute on function public.clicktide_shopify_customer_data(text, text, text) to service_role;
grant execute on function public.clicktide_shopify_apply_entitlement(text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.clicktide_shopify_claim(text, uuid) to service_role;
