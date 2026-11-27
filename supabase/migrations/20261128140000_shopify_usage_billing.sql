-- Shopify usage billing (App Store rule 1.2): for a business billed through Shopify, postcards,
-- gifts and texts past the plan's limit go on its Shopify bill instead of a Stripe-funded wallet.
--
-- Every such charge already passes through clicktide_wallet_apply (campaign-runner, the gift
-- fulfillers via clicktide_debit_gift_wallet[_server], send-customer-sms, printify-webhook).
-- For a Shopify-billed business (clicktide_shopify_usage_billed) and only for the usage kinds
-- (gift_debit, postcard_debit, sms_overage and their *_refund), the debit no longer needs a
-- prepaid balance and doesn't move it; the row is marked wallet.shopify_usage and later reported to Shopify's App
-- Events API by shopify-webhooks (idempotency key = the wallet row id, enforced by Shopify).
-- Everything else in the ledger (locks, idempotency, kind/sign checks, the writer flag, the
-- browser guard, Stripe top-ups/refunds) is unchanged.

alter table public.wallet
  add column if not exists shopify_usage boolean not null default false,
  add column if not exists shopify_usage_reported_at timestamptz,
  add column if not exists shopify_usage_attempts integer not null default 0,
  add column if not exists shopify_usage_error text;
create index if not exists wallet_shopify_usage_pending_idx on public.wallet (id)
  where shopify_usage and shopify_usage_reported_at is null;

-- Billed through Shopify right now: Shopify billing provider, a live subscription, and a
-- working store connection (usage events need the shop).
create or replace function public.clicktide_shopify_usage_billed(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
           select 1 from public.clicktide k
            where k.user_id = p_user and k.billing_provider = 'shopify'
              and lower(coalesce(k.stripe_subscription_status, '')) in ('active', 'trialing', 'past_due'))
     and exists (
           select 1 from public.platform_connections c
            where c.user_id = p_user and c.platform = 'shopify' and c.is_active
              and coalesce(c.access_token, '') <> '');
$$;
revoke all on function public.clicktide_shopify_usage_billed(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_usage_billed(uuid) to service_role;

-- The ledger: unchanged except the Shopify usage branch (v_shop).
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

  -- Shopify-billed business: usage goes on its Shopify bill, so no prepaid balance is needed.
  if v_kind in ('gift_debit', 'postcard_debit', 'sms_overage', 'gift_refund', 'postcard_refund', 'sms_overage_refund') then
    v_shop := public.clicktide_shopify_usage_billed(p_user);
  end if;

  v_prev := public.clicktide_wallet_balance(p_user);
  -- A Shopify usage row is billed by Shopify, so it never moves the prepaid balance.
  v_new  := v_prev + case when v_shop then 0 else v_delta end;
  if v_delta < 0 and v_new < 0 and not v_shop then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'balance', v_prev);
  end if;

  -- Tells wallet_ledger_guard this row comes from the ledger, not from a browser insert.
  perform pg_catalog.set_config('clicktide.wallet_writer', 'ledger', true);
  begin
    insert into public.wallet (
      user_id, "desc", amount, balance, transaction_type, status, reference_id, idempotency_key, created_at, shopify_usage
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
      v_shop
    );
  exception when unique_violation then
    perform pg_catalog.set_config('clicktide.wallet_writer', '', true);
    return jsonb_build_object('ok', true, 'balance', public.clicktide_wallet_balance(p_user), 'duplicate', true);
  end;
  perform pg_catalog.set_config('clicktide.wallet_writer', '', true);

  return jsonb_build_object('ok', true, 'balance', v_new, 'duplicate', false, 'shopify_usage', v_shop);
end;
$function$;

-- The insert guard: unchanged except (a) a browser (staff) insert can never set shopify_usage,
-- and (b) a ledger-written Shopify usage row may take the running balance below zero.
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
    new.shopify_usage            := false;
    new.shopify_usage_reported_at := null;
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

-- Reporter queue (shopify-webhooks): unreported usage rows with the shop to bill.
create or replace function public.clicktide_shopify_usage_pending(p_limit integer default 100)
returns table (id bigint, user_id uuid, amount numeric, transaction_type text, created_at timestamptz, merchant_id text, shop_domain text, attempts integer)
language sql stable security definer set search_path = '' as $$
  select w.id, w.user_id, w.amount::numeric, w.transaction_type, w.created_at, c.merchant_id, c.shop_domain, w.shopify_usage_attempts
    from public.wallet w
    join lateral (select pc.merchant_id, pc.shop_domain from public.platform_connections pc
                   where pc.user_id = w.user_id and pc.platform = 'shopify'
                   order by pc.is_active desc, pc.updated_at desc limit 1) c on true
   where w.shopify_usage and w.shopify_usage_reported_at is null and w.shopify_usage_attempts < 10
   order by w.id
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

create or replace function public.clicktide_shopify_usage_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.wallet
     set shopify_usage_reported_at = case when p_ok then pg_catalog.clock_timestamp() else shopify_usage_reported_at end,
         shopify_usage_attempts = shopify_usage_attempts + 1,
         shopify_usage_error = case when p_ok then null else left(coalesce(p_error, 'error'), 300) end
   where id = p_id and shopify_usage and shopify_usage_reported_at is null;
$$;
revoke all on function public.clicktide_shopify_usage_pending(integer) from public, anon, authenticated;
revoke all on function public.clicktide_shopify_usage_mark(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.clicktide_shopify_usage_pending(integer) to service_role;
grant execute on function public.clicktide_shopify_usage_mark(bigint, boolean, text) to service_role;
