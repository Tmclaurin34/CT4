-- WP2 (gifts): idempotent gift sends, tenant-safe Printify webhook matching, and no
-- browser writes to the gift tables. Idempotent and additive: safe to re-run, changes
-- no existing rows.
--
-- The WP2 edge functions also need, at run time (not for this file to apply):
--   * public.clicktide_wallet_apply(...)  from WP1 (contract C1)
--   * public.email_suppressions          from WP4 (contract C2)
-- Apply those migrations and this one before deploying the WP2 functions.

-- ---------------------------------------------------------------------------
-- 1. Gift send claims: one row per logical gift send.
--    A fulfill function claims the key before any money moves. A repeat of the
--    same request finds the row and never orders or charges twice; a send that
--    failed (and was refunded) can be claimed again as the next attempt.
-- ---------------------------------------------------------------------------
create table if not exists public.gift_send_claims (
  idempotency_key   text primary key,
  user_id           uuid not null,
  provider          text not null,
  catalog_id        uuid,
  customer_id       bigint,
  campaign_id       text,
  amount            numeric(12,2),
  origin            text not null default 'manual'
                    check (origin in ('manual', 'auto')),
  status            text not null default 'pending'
                    check (status in ('pending', 'placed', 'failed', 'refund_pending')),
  attempt           integer not null default 1,
  provider_order_id text,
  shipment_id       bigint,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Service role only. Rows left 'pending' for more than a few minutes, and 'refund_pending'
-- rows, need an operator to reconcile (queries in TESTS.md).

create index if not exists gift_send_claims_user_created_idx
  on public.gift_send_claims (user_id, created_at desc);
create index if not exists gift_send_claims_open_idx
  on public.gift_send_claims (updated_at)
  where status in ('pending', 'refund_pending');
-- A manual send is refused while the same gift was auto-sent to the same customer in the
-- last 24h (campaign-runner can time out on an order that still goes through).
create index if not exists gift_send_claims_recent_auto_idx
  on public.gift_send_claims (user_id, customer_id, catalog_id, created_at desc)
  where origin = 'auto';

alter table public.gift_send_claims enable row level security;
revoke all on table public.gift_send_claims from public, anon, authenticated;
grant select, insert, update on table public.gift_send_claims to service_role;

-- Atomically claim a send key. Returns
--   {"claimed":true,"attempt":n}                         go ahead (attempt n)
--   {"claimed":false,"state":"placed",...}               already ordered: replay it
--   {"claimed":false,"state":"pending"|"refund_pending"} in flight or being reconciled
--   {"claimed":false,"state":"invalid"|"conflict"}
create or replace function public.clicktide_gift_claim(
  p_key         text,
  p_user        uuid,
  p_provider    text,
  p_catalog_id  uuid,
  p_customer_id bigint,
  p_campaign_id text,
  p_amount      numeric,
  p_origin      text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.gift_send_claims%rowtype;
begin
  if p_key is null or length(p_key) < 32 or length(p_key) > 200 or p_user is null then
    return jsonb_build_object('claimed', false, 'state', 'invalid');
  end if;

  insert into public.gift_send_claims
    (idempotency_key, user_id, provider, catalog_id, customer_id, campaign_id, amount, origin)
  values
    (p_key, p_user, coalesce(p_provider, ''), p_catalog_id, p_customer_id, p_campaign_id, p_amount,
     case when p_origin = 'auto' then 'auto' else 'manual' end)
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if found then
    return jsonb_build_object('claimed', true, 'attempt', v_row.attempt);
  end if;

  select * into v_row
    from public.gift_send_claims
   where idempotency_key = p_key
   for update;

  if not found or v_row.user_id is distinct from p_user then
    return jsonb_build_object('claimed', false, 'state', 'conflict');
  end if;

  if v_row.status = 'failed' then
    update public.gift_send_claims
       set status     = 'pending',
           attempt    = attempt + 1,
           provider   = coalesce(p_provider, provider),
           catalog_id = p_catalog_id,
           amount     = p_amount,
           error      = null,
           updated_at = now()
     where idempotency_key = p_key
    returning * into v_row;
    return jsonb_build_object('claimed', true, 'attempt', v_row.attempt);
  end if;

  return jsonb_build_object(
    'claimed', false,
    'state', v_row.status,
    'attempt', v_row.attempt,
    'provider', v_row.provider,
    'shipment_id', v_row.shipment_id,
    'provider_order_id', v_row.provider_order_id
  );
end;
$$;

revoke all on function public.clicktide_gift_claim(text, uuid, text, uuid, bigint, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.clicktide_gift_claim(text, uuid, text, uuid, bigint, text, numeric, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Shipments: remember which wallet debit paid for each gift, so a provider
--    cancellation can be refunded exactly once, and make provider order ids
--    unique so a webhook event can only ever match the order it belongs to.
-- ---------------------------------------------------------------------------
alter table public.shipments add column if not exists idempotency_key     text;
alter table public.shipments add column if not exists gift_catalog_id     uuid;
alter table public.shipments add column if not exists wallet_debit_key    text;
alter table public.shipments add column if not exists wallet_debit_amount numeric(12,2);
alter table public.shipments add column if not exists wallet_refunded_at  timestamptz;

create unique index if not exists shipments_idempotency_key_unique
  on public.shipments (idempotency_key);

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'shipments_provider_order_unique'
  ) then
    if exists (
      select 1
        from public.shipments
       where printify_order_id is not null
       group by platform, printify_order_id
      having count(*) > 1
    ) then
      raise warning 'shipments_provider_order_unique NOT created: duplicate (platform, printify_order_id) rows exist. Resolve them, then re-run this migration.';
    else
      create unique index shipments_provider_order_unique
        on public.shipments (platform, printify_order_id)
        where printify_order_id is not null;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Browser roles never write these tables (the dashboard and back office only
--    read them; the edge functions write with the service role). Without write
--    grants, an owner can no longer plant a shipments row carrying another
--    tenant's order id, or point brand_products at a shared catalog product.
--    SELECT (and RLS) is unchanged. gift_catalog keeps authenticated writes,
--    which RLS limits to admin/support staff (back-office catalog panel).
--    TRUNCATE is not subject to RLS, so it is removed everywhere here.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on table public.shipments from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.brand_products from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.gift_catalog from anon;
revoke truncate, references, trigger
  on table public.gift_catalog from authenticated;
