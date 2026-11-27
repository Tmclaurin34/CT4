-- Data retention rule (Shopify protected customer data: "retention periods").
--  * While a business has a live plan (active / trialing / past_due) its data is kept.
--  * clicktide.data_closed_at records when a business stopped having a live plan
--    (computed by trigger from stripe_subscription_status; client writes are ignored).
--  * 90 days after data_closed_at, that business's shopper data is deleted:
--    customers (+ visits, rhythm, status events, transaction ledger, sends cascade),
--    SMS history, the personal fields on gift shipments, and POS/Shopify tokens.
--    Business account, billing and wallet records are kept (financial records).
--  * Rolling limits for everyone: expired OAuth states (1 day), funnel events
--    (13 months), transaction de-dup ledger (400 days), SMS history (2 years).
--  clicktide_retention_purge(p_dry_run) reports what it would delete when dry.

alter table public.clicktide add column if not exists data_closed_at timestamptz;

create or replace function public.clicktide_retention_closed_at()
returns trigger language plpgsql as $$
begin
  if coalesce(new.stripe_subscription_status, '') in ('active', 'trialing', 'past_due') then
    new.data_closed_at := null;
  elsif tg_op = 'INSERT' then
    new.data_closed_at := now();
  else
    new.data_closed_at := coalesce(old.data_closed_at, now());
  end if;
  return new;
end $$;

drop trigger if exists clicktide_retention_closed_at on public.clicktide;
create trigger clicktide_retention_closed_at before insert or update on public.clicktide
  for each row execute function public.clicktide_retention_closed_at();

-- Start the 90-day clock today for accounts without a live plan (nothing is deleted before 2027-02-25).
update public.clicktide set data_closed_at = now()
 where data_closed_at is null and coalesce(stripe_subscription_status, '') not in ('active', 'trialing', 'past_due');

create or replace function public.clicktide_retention_purge(p_dry_run boolean default true, p_grace interval default interval '90 days')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  closed uuid[];
  out jsonb := '{}'::jsonb;
  n bigint;
begin
  select coalesce(array_agg(k.user_id), '{}') into closed
    from clicktide k
   where k.user_id is not null
     and k.data_closed_at < now() - p_grace
     and coalesce(k.stripe_subscription_status, '') not in ('active', 'trialing', 'past_due')
     and not exists (select 1 from clicktide_staff s where s.user_id = k.user_id and s.is_active);
  out := out || jsonb_build_object('closed_businesses', cardinality(closed), 'dry_run', p_dry_run);

  if p_dry_run then
    select count(*) into n from customers where user_id = any(closed);              out := out || jsonb_build_object('customers', n);
    select count(*) into n from sms_messages where user_id = any(closed) or created_at < now() - interval '2 years'; out := out || jsonb_build_object('sms_messages', n);
    select count(*) into n from shipments where user_id = any(closed) and (customer_name is not null or customer_email is not null or address is not null); out := out || jsonb_build_object('shipments_scrubbed', n);
    select count(*) into n from platform_connections where user_id = any(closed) and coalesce(access_token, '') <> ''; out := out || jsonb_build_object('tokens_wiped', n);
    select count(*) into n from oauth_states where expires_at < now() - interval '1 day'; out := out || jsonb_build_object('oauth_states', n);
    select count(*) into n from funnel_events where created_at < now() - interval '13 months'; out := out || jsonb_build_object('funnel_events', n);
    select count(*) into n from pos_transactions_seen where seen_at < now() - interval '400 days'; out := out || jsonb_build_object('pos_transactions_seen', n);
    return out;
  end if;

  delete from sms_messages where user_id = any(closed) or created_at < now() - interval '2 years'; get diagnostics n = row_count; out := out || jsonb_build_object('sms_messages', n);
  update shipments set customer_name = null, customer_email = null, address = null
   where user_id = any(closed) and (customer_name is not null or customer_email is not null or address is not null);
  get diagnostics n = row_count; out := out || jsonb_build_object('shipments_scrubbed', n);
  delete from customers where user_id = any(closed); get diagnostics n = row_count; out := out || jsonb_build_object('customers', n);
  update platform_connections set access_token = '', refresh_token = null, is_active = false, raw_response = '{}'::jsonb, updated_at = now()
   where user_id = any(closed) and coalesce(access_token, '') <> '';
  get diagnostics n = row_count; out := out || jsonb_build_object('tokens_wiped', n);
  delete from oauth_states where expires_at < now() - interval '1 day'; get diagnostics n = row_count; out := out || jsonb_build_object('oauth_states', n);
  delete from funnel_events where created_at < now() - interval '13 months'; get diagnostics n = row_count; out := out || jsonb_build_object('funnel_events', n);
  delete from pos_transactions_seen where seen_at < now() - interval '400 days'; get diagnostics n = row_count; out := out || jsonb_build_object('pos_transactions_seen', n);
  return out;
end $$;
revoke all on function public.clicktide_retention_purge(boolean, interval) from public, anon, authenticated;
