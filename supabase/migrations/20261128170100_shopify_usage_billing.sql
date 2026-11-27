-- Shopify usage billing v3 (App Store rule 1.2): for a business billed through Shopify, postcards,
-- gifts and texts past the plan's limit go on its Shopify bill instead of a Stripe-funded wallet.
--
-- Every such charge already passes through clicktide_wallet_apply (campaign-runner, the gift
-- fulfillers, send-customer-sms, printify-webhook). For a Shopify-billed business
-- (billing_provider = 'shopify') and only the usage kinds (gift_debit, postcard_debit, sms_overage
-- and their *_refund):
--   1. a prepaid balance that covers the whole debit pays it, as today (money left over from
--      before the switch stays spendable);
--   2. otherwise, if clicktide_shopify_usage_allowed, the whole debit becomes Shopify usage:
--      wallet.shopify_usage, the shop and merchant id it bills are stored on the row, and the
--      prepaid balance doesn't move;
--   3. otherwise it is refused: {ok:false, reason:'insufficient_funds', shopify_usage_refused:true}
--      (callers already treat insufficient_funds as "not started").
-- A refund follows ITS OWN debit (idempotency key = '<debit key>:refund'): it is Shopify usage
-- only if that exact debit was, so a refund of a prepaid charge always re-credits prepaid.
-- shopify-webhooks reports usage rows to Shopify's App Events API (idempotency key = row id).
-- Every other ledger path (locks, idempotency, kind/sign checks, Stripe top-ups/refunds, staff
-- refunds) is unchanged.
--
-- Safety (security review v2 -> v3): Shopify App Pricing meters have no Shopify-side cap, so
-- Clicktide keeps its own per-cycle limit (shopify_usage_limits, written only by the
-- subscription sync). Usage is allowed only if: Shopify-billed with a live, non-trial
-- subscription; exactly one active Shopify connection, which is the billed shop and the shop the
-- limits were synced for; not a test charge or development store; synced within 3 hours; inside
-- the cycle; and this cycle's usage + the debit within the limit. Anything else fails closed.

alter table public.wallet
  add column if not exists shopify_usage boolean not null default false,
  add column if not exists shopify_usage_reported_at timestamptz,
  add column if not exists shopify_usage_attempts integer not null default 0,
  add column if not exists shopify_usage_error text,
  add column if not exists shopify_usage_next_at timestamptz,
  add column if not exists shopify_usage_cancelled_at timestamptz,
  add column if not exists shopify_shop_domain text,
  add column if not exists shopify_merchant_id text;
create index if not exists wallet_shopify_usage_pending_idx on public.wallet (id)
  where shopify_usage and shopify_usage_reported_at is null and shopify_usage_cancelled_at is null;

-- Server-only usage limits per business, from the Shopify subscription sync.
create table if not exists public.shopify_usage_limits (
  user_id uuid primary key,
  shop_domain text not null,
  plan text,
  cycle_start timestamptz,
  cycle_end timestamptz,
  cycle_limit numeric not null default 0,
  test_or_dev boolean not null default true,
  trialing boolean not null default true,
  capped_amount numeric,   -- legacy Billing API AppUsagePricing only (App Pricing has none)
  balance_used numeric,    -- same: what Shopify says it has billed this cycle
  synced_at timestamptz not null default now()
);
alter table public.shopify_usage_limits enable row level security;
revoke all on public.shopify_usage_limits from public, anon, authenticated;
grant select, insert, update, delete on public.shopify_usage_limits to service_role;

-- One reporter at a time (the nightly run and the 10-minute run can overlap).
create table if not exists public.shopify_usage_job (
  id integer primary key default 1 check (id = 1),
  holder text,
  lease_until timestamptz
);
alter table public.shopify_usage_job enable row level security;
revoke all on public.shopify_usage_job from public, anon, authenticated;
grant select, insert, update on public.shopify_usage_job to service_role;

-- Clicktide's per-cycle limit for usage billed through Shopify (dollars). Change here.
-- p_trial: Shopify's docs don't say whether usage during a free trial is billed, so it is 0
-- (refused) until that is confirmed.
create or replace function public.clicktide_shopify_usage_plan_limit(p_plan text, p_trial boolean default false)
returns numeric language sql immutable set search_path = '' as $$
  select case when coalesce(p_trial, true) then 0
              else case p_plan when 'Local' then 150 when 'Growth' then 400 when 'Scale' then 900 else 0 end end::numeric;
$$;

-- Called by the Shopify billing sync (reconcileBilling) after reading the shop's subscription.
create or replace function public.clicktide_shopify_usage_sync(
  p_shop text, p_plan text, p_period_end timestamptz, p_test_or_dev boolean,
  p_trialing boolean default true, p_capped numeric default null, p_balance_used numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_n int; v_end timestamptz; v_limit numeric;
begin
  select count(distinct c.user_id), min(c.user_id::text)::uuid into v_n, v_user from public.platform_connections c
   where c.platform = 'shopify' and lower(c.shop_domain) = lower(p_shop) and c.is_active and c.user_id is not null;
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'no_business'); end if;
  if v_n > 1 then return jsonb_build_object('ok', false, 'reason', 'shop_on_several_businesses'); end if;
  -- An unknown period end leaves the cycle unknown, which refuses usage (fail closed).
  v_end := case when p_period_end > pg_catalog.now() - interval '1 day' then p_period_end end;
  v_limit := public.clicktide_shopify_usage_plan_limit(p_plan, p_trialing);
  if p_capped is not null then v_limit := least(v_limit, greatest(p_capped, 0)); end if;
  insert into public.shopify_usage_limits as l (user_id, shop_domain, plan, cycle_start, cycle_end, cycle_limit, test_or_dev, trialing, capped_amount, balance_used, synced_at)
  values (v_user, lower(p_shop), p_plan, v_end - interval '30 days', v_end, v_limit, coalesce(p_test_or_dev, true), coalesce(p_trialing, true), p_capped, p_balance_used, pg_catalog.now())
  on conflict (user_id) do update set shop_domain = excluded.shop_domain, plan = excluded.plan, cycle_start = excluded.cycle_start,
    cycle_end = excluded.cycle_end, cycle_limit = excluded.cycle_limit, test_or_dev = excluded.test_or_dev, trialing = excluded.trialing,
    capped_amount = excluded.capped_amount, balance_used = excluded.balance_used, synced_at = excluded.synced_at;
  return jsonb_build_object('ok', true, 'user_id', v_user, 'cycle_end', v_end, 'limit', v_limit);
end $$;

-- The one shop a business's usage can bill: exactly one active Shopify connection, with a token
-- and a numeric shop id, that is the business's billed shop (clicktide.shopify_shop_domain).
create or replace function public.clicktide_shopify_usage_target(p_user uuid)
returns table (shop_domain text, merchant_id text) language sql stable security definer set search_path = '' as $$
  select lower(c.shop_domain), c.merchant_id
    from public.platform_connections c
    join public.clicktide k on k.user_id = c.user_id
   where c.user_id = p_user and c.platform = 'shopify' and c.is_active
     and coalesce(c.access_token, '') <> '' and coalesce(c.merchant_id, '') ~ '^[0-9]+$'
     and lower(c.shop_domain) = lower(coalesce(k.shopify_shop_domain, ''))
     and (select count(*) from public.platform_connections x
           where x.user_id = p_user and x.platform = 'shopify' and x.is_active) = 1;
$$;

-- This cycle's Shopify usage: debits made in the cycle, less refunds of those same debits.
-- p_reported_only: just what Shopify has acknowledged (2xx).
create or replace function public.clicktide_shopify_usage_cycle_used(p_user uuid, p_cycle_start timestamptz, p_reported_only boolean default false)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(-round(d.amount::double precision::numeric, 2)) from public.wallet d
                    where d.user_id = p_user and d.shopify_usage and d.shopify_usage_cancelled_at is null
                      and d.transaction_type in ('gift_debit', 'postcard_debit', 'sms_overage')
                      and d.created_at >= p_cycle_start
                      and (not p_reported_only or d.shopify_usage_reported_at is not null)), 0)
       - coalesce((select sum(round(r.amount::double precision::numeric, 2)) from public.wallet r
                    join public.wallet d on d.user_id = r.user_id and d.idempotency_key = left(r.idempotency_key, length(r.idempotency_key) - 7)
                   where r.user_id = p_user and r.shopify_usage and r.shopify_usage_cancelled_at is null
                     and r.transaction_type in ('gift_refund', 'postcard_refund', 'sms_overage_refund')
                     and r.idempotency_key like '%:refund'
                     and d.shopify_usage and d.created_at >= p_cycle_start
                     and (not p_reported_only or r.shopify_usage_reported_at is not null)), 0);
$$;

-- May this debit go on the business's Shopify bill? See the header for the rules.
create or replace function public.clicktide_shopify_usage_allowed(p_user uuid, p_debit numeric)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
           select 1 from public.clicktide k
            where k.user_id = p_user and k.billing_provider = 'shopify'
              and lower(coalesce(k.stripe_subscription_status, '')) in ('active', 'past_due'))
     and exists (
           select 1 from public.shopify_usage_limits l
            join public.clicktide_shopify_usage_target(p_user) t on t.shop_domain = lower(l.shop_domain)
            where l.user_id = p_user and not l.test_or_dev and not l.trialing and l.cycle_limit > 0
              and l.synced_at > pg_catalog.now() - interval '3 hours'
              and l.cycle_start <= pg_catalog.now() and pg_catalog.now() < l.cycle_end
              and public.clicktide_shopify_usage_cycle_used(p_user, l.cycle_start)
                  + greatest(coalesce(p_debit, 0), 0) <= l.cycle_limit);
$$;

-- The ledger: unchanged except the Shopify usage branch (v_shop / v_billed).
CREATE OR REPLACE FUNCTION public.clicktide_wallet_apply(p_user uuid, p_delta numeric, p_kind text, p_description text, p_reference text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_delta numeric;
  v_key   text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_kind  text := btrim(coalesce(p_kind, ''));
  v_prev  numeric;
  v_new   numeric;
  v_shop  boolean := false;
  v_billed boolean := false;
  v_sdom  text;
  v_smid  text;
begin
  if p_user is null or p_delta is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  v_delta := round(p_delta, 2);
  -- "not (x <= cap)" also rejects NaN and infinity.
  if v_delta = 0 or not (abs(v_delta) <= 1000000) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  if v_kind in ('topup', 'dispute_reinstated', 'gift_refund', 'postcard_refund', 'sms_overage_refund') then
    if v_delta < 0 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
    end if;
  elsif v_kind in ('gift_debit', 'postcard_debit', 'sms_overage', 'refund', 'dispute', 'debt_recovery') then
    if v_delta > 0 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
    end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wallet:' || p_user::text));

  if v_key is not null and exists (select 1 from public.wallet w where w.idempotency_key = v_key) then
    return jsonb_build_object('ok', true, 'balance', public.clicktide_wallet_balance(p_user), 'duplicate', true);
  end if;

  v_prev := public.clicktide_wallet_balance(p_user);

  if v_kind in ('gift_debit', 'postcard_debit', 'sms_overage') then
    v_billed := exists (select 1 from public.clicktide k where k.user_id = p_user and k.billing_provider = 'shopify');
    -- Shopify-billed: prepaid first (whole debit), else the whole debit as Shopify usage, else refuse.
    -- A Shopify usage debit needs an idempotency key, so its refund can find it.
    if v_billed and v_prev + v_delta < 0 then
      if v_key is not null and public.clicktide_shopify_usage_allowed(p_user, -v_delta) then
        select t.shop_domain, t.merchant_id into v_sdom, v_smid from public.clicktide_shopify_usage_target(p_user) t;
        v_shop := v_smid is not null;
      end if;
      if not v_shop then
        return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'shopify_usage_refused', true, 'balance', v_prev);
      end if;
    end if;
  elsif v_kind in ('gift_refund', 'postcard_refund', 'sms_overage_refund') and v_key like '%:refund' then
    -- A refund follows its own debit: Shopify usage (same shop) only if that exact debit was.
    select d.shopify_shop_domain, d.shopify_merchant_id into v_sdom, v_smid
      from public.wallet d
     where d.user_id = p_user and d.idempotency_key = left(v_key, length(v_key) - 7) and d.shopify_usage
       and d.transaction_type = case v_kind when 'gift_refund' then 'gift_debit'
                                            when 'postcard_refund' then 'postcard_debit' else 'sms_overage' end
       and -round(d.amount::double precision::numeric, 2) >= v_delta;
    v_shop := found;
  end if;

  -- A Shopify usage row is billed by Shopify, so it never moves the prepaid balance.
  v_new  := v_prev + case when v_shop then 0 else v_delta end;
  if v_delta < 0 and v_new < 0 and not v_shop then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'balance', v_prev);
  end if;

  -- Tells wallet_ledger_guard this row comes from the ledger, not from a browser insert.
  perform pg_catalog.set_config('clicktide.wallet_writer', 'ledger', true);
  begin
    insert into public.wallet (
      user_id, "desc", amount, balance, transaction_type, status, reference_id, idempotency_key, created_at,
      shopify_usage, shopify_shop_domain, shopify_merchant_id
    ) values (
      p_user,
      -- The owner dashboard prints this text as HTML.
      left(coalesce(nullif(btrim(pg_catalog.regexp_replace(coalesce(p_description, ''), '[<>]', '', 'g')), ''), 'Wallet adjustment'), 300),
      v_delta,
      v_new,
      v_kind,
      'posted',
      left(nullif(btrim(coalesce(p_reference, '')), ''), 200),
      v_key,
      pg_catalog.clock_timestamp(),
      v_shop,
      case when v_shop then v_sdom end,
      case when v_shop then v_smid end
    );
  exception when unique_violation then
    perform pg_catalog.set_config('clicktide.wallet_writer', '', true);
    return jsonb_build_object('ok', true, 'balance', public.clicktide_wallet_balance(p_user), 'duplicate', true);
  end;
  perform pg_catalog.set_config('clicktide.wallet_writer', '', true);

  return jsonb_build_object('ok', true, 'balance', v_new, 'duplicate', false, 'shopify_usage', v_shop);
end;
$function$;

-- The insert guard: unchanged except (a) any insert that isn't the ledger's (browser, staff,
-- service role) can never create Shopify usage, and (b) a ledger-written Shopify usage row
-- leaves the prepaid balance where it was.
CREATE OR REPLACE FUNCTION public.clicktide_wallet_ledger_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_api     boolean;
  v_amount  numeric;
  v_balance numeric;
  v_ledger  boolean := coalesce(current_setting('clicktide.wallet_writer', true), '') = 'ledger';
begin
  v_api := coalesce(v_role in ('anon', 'authenticated'), false) and not v_ledger;

  if not v_ledger then
    new.shopify_usage              := false;
    new.shopify_usage_reported_at  := null;
    new.shopify_usage_attempts     := 0;
    new.shopify_usage_error        := null;
    new.shopify_usage_next_at      := null;
    new.shopify_usage_cancelled_at := null;
    new.shopify_shop_domain        := null;
    new.shopify_merchant_id        := null;
  end if;

  if v_api then
    -- Checked here too (RLS runs after this trigger), so a non-staff insert can't take the lock.
    if not public.clicktide_is_staff(array['admin', 'support']) then
      raise exception 'Not allowed to write to this wallet' using errcode = '42501';
    end if;
    if new.user_id is null or new.amount is null or not (new.amount < 0)
       or coalesce(new.transaction_type, '') <> 'refund' then
      raise exception 'Only refunds of unused wallet funds can be recorded here' using errcode = '42501';
    end if;
    new.created_by               := auth.uid();
    new.status                   := 'posted';
    new.idempotency_key          := null;
    new.reference_id             := null;
    new.stripe_session_id        := null;
    new.stripe_payment_intent_id := null;
    new.stripe_customer_id       := null;
    new."desc" := left(pg_catalog.regexp_replace(coalesce(nullif(btrim(new."desc"), ''), 'Unused gift wallet refund'), '[<>]', '', 'g'), 300);
    new.note   := nullif(left(pg_catalog.regexp_replace(coalesce(new.note, ''), '[<>]', '', 'g'), 500), '');
  end if;

  if new.user_id is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wallet:' || new.user_id::text));
  v_amount := round(coalesce(new.amount, 0)::double precision::numeric, 2);

  -- A staff refund is recorded at the amount staff entered. stripe-webhook takes Stripe refunds
  -- off the wallet itself, and the back office tells staff to record only refunds paid outside
  -- Stripe, so nothing is netted against wallet_reversals here (staff_matched stays unused).

  -- A ledger-written Shopify usage row is billed by Shopify: the prepaid balance doesn't move.
  v_balance      := public.clicktide_wallet_balance(new.user_id)
                    + case when v_ledger and coalesce(new.shopify_usage, false) then 0 else v_amount end;
  new.amount     := v_amount;
  new.balance    := v_balance;
  new.created_at := pg_catalog.clock_timestamp();
  if v_amount < 0 and v_balance < 0 then
    raise exception 'Insufficient gift wallet balance';
  end if;
  return new;
end;
$function$;

-- Reporter lease: one run at a time. True if p_holder now holds it for p_seconds.
create or replace function public.clicktide_shopify_usage_lease(p_holder text, p_seconds integer default 300)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  insert into public.shopify_usage_job as j (id, holder, lease_until)
  values (1, p_holder, pg_catalog.now() + make_interval(secs => greatest(30, least(coalesce(p_seconds, 300), 900))))
  on conflict (id) do update set holder = excluded.holder, lease_until = excluded.lease_until
   where j.lease_until is null or j.lease_until < pg_catalog.now() or j.holder = excluded.holder
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function public.clicktide_shopify_usage_release(p_holder text)
returns void language sql security definer set search_path = '' as $$
  update public.shopify_usage_job set lease_until = null where id = 1 and holder = p_holder;
$$;

-- Reporter queue: CLAIMS due, unreported, uncancelled usage rows (next_at = now + 15 min, so a
-- second runner or the netting step leaves them alone) and returns them with the shop stored on
-- the row at debit time (still reportable after shop/redact deletes the connection).
create or replace function public.clicktide_shopify_usage_pending(p_limit integer default 100)
returns table (id bigint, user_id uuid, amount numeric, transaction_type text, created_at timestamptz, merchant_id text, shop_domain text, attempts integer)
language sql volatile security definer set search_path = '' as $$
  with c as (
    select w.id from public.wallet w
     where w.shopify_usage and w.shopify_usage_reported_at is null and w.shopify_usage_cancelled_at is null
       and (w.shopify_usage_next_at is null or w.shopify_usage_next_at <= pg_catalog.now())
     order by w.id
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update skip locked),
  u as (
    update public.wallet w set shopify_usage_next_at = pg_catalog.now() + interval '15 minutes'
      from c where w.id = c.id
    returning w.id, w.user_id, round(w.amount::double precision::numeric, 2) as amount, w.transaction_type, w.created_at,
              w.shopify_merchant_id, w.shopify_shop_domain, w.shopify_usage_attempts)
  select * from u order by id;
$$;

-- After a send. Only a 2xx (p_ok) sets reported_at. A failure backs off (2^attempts minutes,
-- max 6 hours). If Shopify accepted a row that netting had meanwhile cancelled, the row is
-- un-cancelled and its partner (debit <-> '<key>:refund') re-queued, so nothing is lost.
create or replace function public.clicktide_shopify_usage_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare w record; v_partner text;
begin
  select * into w from public.wallet where id = p_id and shopify_usage and shopify_usage_reported_at is null for update;
  if not found then return; end if;
  if p_ok then
    update public.wallet set shopify_usage_reported_at = pg_catalog.clock_timestamp(), shopify_usage_attempts = shopify_usage_attempts + 1,
           shopify_usage_error = null, shopify_usage_next_at = null, shopify_usage_cancelled_at = null
     where id = p_id;
    if w.shopify_usage_cancelled_at is not null and w.idempotency_key is not null then
      v_partner := case when w.idempotency_key like '%:refund' then left(w.idempotency_key, length(w.idempotency_key) - 7)
                        else w.idempotency_key || ':refund' end;
      update public.wallet set shopify_usage_cancelled_at = null, shopify_usage_next_at = null,
             shopify_usage_error = 're-queued: partner ' || p_id || ' was reported'
       where user_id = w.user_id and idempotency_key = v_partner and shopify_usage and shopify_usage_reported_at is null;
    end if;
  elsif w.shopify_usage_cancelled_at is null then
    update public.wallet set shopify_usage_attempts = shopify_usage_attempts + 1,
           shopify_usage_error = left(coalesce(p_error, 'error'), 300),
           shopify_usage_next_at = pg_catalog.clock_timestamp() + least(interval '6 hours', interval '1 minute' * power(2, least(shopify_usage_attempts, 12)))
     where id = p_id;
  end if;
end $$;

-- A refund whose own debit (key = refund key minus ':refund') was never sent cancels with it, at
-- the same amount. Rows that were ever claimed or sent (attempts > 0, or next_at in the future)
-- are never netted. Returns pairs netted.
create or replace function public.clicktide_shopify_usage_net()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_debit bigint; n integer := 0;
begin
  for r in select w.id, w.user_id, w.idempotency_key, w.amount, w.transaction_type from public.wallet w
            where w.shopify_usage and w.shopify_usage_reported_at is null and w.shopify_usage_cancelled_at is null
              and w.shopify_usage_attempts = 0 and (w.shopify_usage_next_at is null or w.shopify_usage_next_at <= pg_catalog.now())
              and w.transaction_type in ('gift_refund', 'postcard_refund', 'sms_overage_refund')
              and w.idempotency_key like '%:refund'
            order by w.id for update skip locked loop
    v_debit := null;
    select d.id into v_debit from public.wallet d
     where d.user_id = r.user_id and d.idempotency_key = left(r.idempotency_key, length(r.idempotency_key) - 7)
       and d.shopify_usage and d.shopify_usage_reported_at is null and d.shopify_usage_cancelled_at is null
       and d.shopify_usage_attempts = 0 and (d.shopify_usage_next_at is null or d.shopify_usage_next_at <= pg_catalog.now())
       and round(d.amount::double precision::numeric, 2) = -round(r.amount::double precision::numeric, 2)
       and d.transaction_type = case r.transaction_type when 'gift_refund' then 'gift_debit'
                                                        when 'postcard_refund' then 'postcard_debit' else 'sms_overage' end
     for update skip locked;
    if v_debit is not null then
      update public.wallet set shopify_usage_cancelled_at = pg_catalog.clock_timestamp(),
             shopify_usage_error = 'netted: ' || v_debit || ' + ' || r.id
       where id in (v_debit, r.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Ops: usage still unreported an hour after it happened (so it can't silently become free).
create or replace function public.clicktide_shopify_usage_overdue()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('rows', count(*), 'amount', coalesce(sum(abs(round(amount::double precision::numeric, 2))), 0),
                            'oldest', min(created_at), 'no_shop_id', count(*) filter (where coalesce(shopify_merchant_id, '') !~ '^[0-9]+$'))
    from public.wallet
   where shopify_usage and shopify_usage_reported_at is null and shopify_usage_cancelled_at is null
     and created_at < pg_catalog.now() - interval '1 hour';
$$;

-- Ops: where Shopify reports what it billed this cycle (legacy AppUsagePricing balanceUsed only;
-- App Pricing exposes no such number to the Admin API), compare it with what we reported.
create or replace function public.clicktide_shopify_usage_mismatches()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', l.user_id, 'shop', l.shop_domain, 'shopify_balance_used', l.balance_used, 'reported', x.rep)), '[]'::jsonb)
    from public.shopify_usage_limits l
    cross join lateral (select public.clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start, true) rep) x
   where l.balance_used is not null and l.cycle_start is not null
     and abs(l.balance_used - x.rep) > 0.01
     and l.synced_at > pg_catalog.now() - interval '3 hours';
$$;

-- Owner dashboard: what this business has billed through Shopify this cycle (own row only).
create or replace function public.clicktide_shopify_usage_this_cycle()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'billed', public.clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start),
    'reported', public.clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start, true),
    'limit', l.cycle_limit, 'cycle_end', l.cycle_end, 'test_or_dev', l.test_or_dev, 'trialing', l.trialing)
    from public.shopify_usage_limits l where l.user_id = auth.uid() and l.cycle_start is not null;
$$;

do $g$
declare f text;
begin
  foreach f in array array[
    'clicktide_shopify_usage_plan_limit(text, boolean)',
    'clicktide_shopify_usage_sync(text, text, timestamptz, boolean, boolean, numeric, numeric)',
    'clicktide_shopify_usage_target(uuid)',
    'clicktide_shopify_usage_cycle_used(uuid, timestamptz, boolean)',
    'clicktide_shopify_usage_allowed(uuid, numeric)',
    'clicktide_shopify_usage_lease(text, integer)',
    'clicktide_shopify_usage_release(text)',
    'clicktide_shopify_usage_pending(integer)',
    'clicktide_shopify_usage_mark(bigint, boolean, text)',
    'clicktide_shopify_usage_net()',
    'clicktide_shopify_usage_overdue()',
    'clicktide_shopify_usage_mismatches()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $g$;
revoke all on function public.clicktide_shopify_usage_this_cycle() from public, anon;
grant execute on function public.clicktide_shopify_usage_this_cycle() to authenticated, service_role;
