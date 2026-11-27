-- WP1-billing 01 — gift wallet ledger: one atomic, idempotent money writer (contract C1).
--
-- public.wallet is a ledger; the newest row's balance is the wallet balance. Until now every
-- writer read that balance and inserted balance +/- amount with no lock, so concurrent gift
-- sends could double-spend, reversals could mint credit and a top-up could erase a debit.
--
--   * public.clicktide_wallet_apply() is the single writer (per-business advisory lock, newest
--     balance, no overdraft, exactly one row, optional idempotency key).
--   * clicktide_wallet_balance / clicktide_debit_gift_wallet_server / clicktide_debit_gift_wallet
--     keep their names, arguments, return types and error messages, and now call it.
--   * Trigger wallet_ledger_guard gives rows inserted directly (older edge-function builds, the
--     back office) the same lock and recomputes balance = previous balance + amount, and limits
--     browser inserts to staff refunds of unused funds.
--   * stripe-webhook helpers: credit a paid top-up, reverse a refunded or disputed top-up,
--     give a won dispute back. All of them post through clicktide_wallet_apply.
--
-- Idempotent and additive: safe to run more than once. No existing row is changed.

-- 1. Ledger columns and indexes -------------------------------------------------------------

alter table public.wallet add column if not exists idempotency_key text;

create unique index if not exists wallet_idempotency_key_unique
  on public.wallet (idempotency_key)
  where idempotency_key is not null;

create index if not exists wallet_stripe_payment_intent_idx
  on public.wallet (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- 2. Refunds and chargebacks of top-ups -----------------------------------------------------
-- The ledger never goes below zero, so a reversal takes what the wallet still holds and keeps
-- the rest as `owed`, which the next top-up repays first.

create table if not exists public.wallet_reversals (
  reference      text primary key,                 -- Stripe charge id (refund) or dispute id
  user_id        uuid not null,
  payment_intent text not null,
  kind           text not null check (kind in ('refund', 'dispute')),
  reversed_total numeric(12,2) not null default 0, -- how much of the top-up this reference takes back
  taken          numeric(12,2) not null default 0, -- debited from the wallet at the time
  owed           numeric(12,2) not null default 0, -- not covered by the balance yet
  recovered      numeric(12,2) not null default 0, -- owed money later taken from new top-ups
  staff_matched  numeric(12,2) not null default 0, -- unused (staff refunds are no longer netted)
  reinstated_at  timestamptz,                      -- dispute won: everything taken was given back
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists wallet_reversals_user_idx on public.wallet_reversals (user_id);
create index if not exists wallet_reversals_payment_intent_idx on public.wallet_reversals (payment_intent);

alter table public.wallet_reversals enable row level security;
revoke all on table public.wallet_reversals from public, anon, authenticated;
grant select, insert, update on table public.wallet_reversals to service_role;

-- 3. Balance ----------------------------------------------------------------------------------
-- wallet.amount/balance are real. real -> numeric keeps only 6 significant digits
-- (12345.67 -> 12345.7), real -> double precision is exact, so every read goes through double.
-- Cents are then exact up to $131,071.99 per value; beyond that the column type must change.

create or replace function public.clicktide_wallet_balance(client_id uuid)
returns numeric
language sql
security definer
set search_path = ''
as $$
  select coalesce((
    select round(w.balance::double precision::numeric, 2)
      from public.wallet w
     where w.user_id = client_id
     order by w.created_at desc, w.id desc
     limit 1
  ), 0)::numeric;
$$;

-- 4. C1: the one money writer ----------------------------------------------------------------
-- Ledger kinds (transaction_type) every package writes through this function, with the sign
-- each must carry. Anything else is refused with reason 'invalid_kind'; a kind with the wrong
-- sign is refused with reason 'invalid_amount'. Nothing is written in either case.
--   credits (+):                    topup, dispute_reinstated
--   debits (-):                     gift_debit, postcard_debit, sms_overage
--   a debit given back (+):         gift_refund, postcard_refund, sms_overage_refund
--   money leaving to the owner (-): refund (staff refund of unused funds / Stripe refund),
--                                   dispute, debt_recovery
-- Rows written before this contract keep their kinds: 'reversal' (+) is a gift refund (read it
-- like 'gift_refund' when totals are computed) and the column default 'adjustment'. Rows
-- inserted directly (wallet_ledger_guard below) are not limited to these kinds, so an older
-- function build still running during a deploy keeps working.

create or replace function public.clicktide_wallet_apply(
  p_user uuid,
  p_delta numeric,
  p_kind text,
  p_description text,
  p_reference text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta numeric;
  v_key   text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_kind  text := btrim(coalesce(p_kind, ''));
  v_prev  numeric;
  v_new   numeric;
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
  v_new  := v_prev + v_delta;
  if v_delta < 0 and v_new < 0 then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'balance', v_prev);
  end if;

  -- Tells wallet_ledger_guard this row comes from the ledger, not from a browser insert.
  perform pg_catalog.set_config('clicktide.wallet_writer', 'ledger', true);
  begin
    insert into public.wallet (
      user_id, "desc", amount, balance, transaction_type, status, reference_id, idempotency_key, created_at
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
      pg_catalog.clock_timestamp()
    );
  exception when unique_violation then
    perform pg_catalog.set_config('clicktide.wallet_writer', '', true);
    return jsonb_build_object('ok', true, 'balance', public.clicktide_wallet_balance(p_user), 'duplicate', true);
  end;
  perform pg_catalog.set_config('clicktide.wallet_writer', '', true);

  return jsonb_build_object('ok', true, 'balance', v_new, 'duplicate', false);
end;
$$;

-- 5. Existing RPCs: same names, arguments, results and messages; now thin wrappers ------------

create or replace function public.clicktide_debit_gift_wallet_server(
  client_id uuid,
  debit_amount numeric,
  description text,
  reference text default null
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if client_id is null then
    raise exception 'Client id is required';
  end if;
  if debit_amount is null or debit_amount <= 0 then
    raise exception 'Debit amount must be greater than zero';
  end if;

  v_result := public.clicktide_wallet_apply(
    client_id, -debit_amount, 'gift_debit', coalesce(nullif(description, ''), 'Gift sent'), reference, null
  );
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    if v_result ->> 'reason' = 'insufficient_funds' then
      raise exception 'Insufficient gift wallet balance';
    end if;
    raise exception 'Debit amount must be greater than zero';
  end if;
  return (v_result ->> 'balance')::numeric;
end;
$$;

create or replace function public.clicktide_debit_gift_wallet(
  client_id uuid,
  debit_amount numeric,
  description text,
  reference text default null
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if client_id is null then
    raise exception 'Client id is required';
  end if;
  if debit_amount is null or debit_amount <= 0 then
    raise exception 'Debit amount must be greater than zero';
  end if;
  if auth.uid() is null then
    raise exception 'Not allowed to debit this wallet';
  end if;
  if auth.uid() is distinct from client_id and not public.clicktide_can_manage_fulfillment(client_id) then
    raise exception 'Not allowed to debit this wallet';
  end if;

  v_result := public.clicktide_wallet_apply(
    client_id, -debit_amount, 'gift_debit', coalesce(nullif(description, ''), 'Gift sent'), reference, null
  );
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    if v_result ->> 'reason' = 'insufficient_funds' then
      raise exception 'Insufficient gift wallet balance';
    end if;
    raise exception 'Debit amount must be greater than zero';
  end if;
  return (v_result ->> 'balance')::numeric;
end;
$$;

-- 6. Rows inserted directly ------------------------------------------------------------------
-- Older builds of the gift-fulfillment functions insert reversals straight into the table, and
-- the back office records refunds that way. Each such row gets the same lock and a balance the
-- database computes, so a stale balance from the caller can no longer win.

create or replace function public.clicktide_wallet_ledger_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_api     boolean;
  v_amount  numeric;
  v_balance numeric;
begin
  v_api := coalesce(v_role in ('anon', 'authenticated'), false)
           and coalesce(current_setting('clicktide.wallet_writer', true), '') <> 'ledger';

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

  v_balance      := public.clicktide_wallet_balance(new.user_id) + v_amount;
  new.amount     := v_amount;
  new.balance    := v_balance;
  new.created_at := pg_catalog.clock_timestamp();
  if v_amount < 0 and v_balance < 0 then
    raise exception 'Insufficient gift wallet balance';
  end if;
  return new;
end;
$$;

create or replace trigger wallet_ledger_guard
  before insert on public.wallet
  for each row execute function public.clicktide_wallet_ledger_guard();

-- 7. stripe-webhook helpers ------------------------------------------------------------------

-- A paid Checkout top-up. Idempotent per Checkout session, including top-ups credited before
-- idempotency keys existed (they carry stripe_session_id).
create or replace function public.clicktide_wallet_credit_topup(
  p_user uuid,
  p_amount numeric,
  p_session_id text,
  p_payment_intent text,
  p_customer text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session text := nullif(btrim(coalesce(p_session_id, '')), '');
  v_key     text;
  v_result  jsonb;
  v_owed    numeric;
  v_pay     numeric;
  v_left    numeric;
  v_take    numeric;
  v_paid    numeric := 0;
  r         record;
begin
  if p_user is null or v_session is null or p_amount is null or not (p_amount > 0) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  v_key := 'topup:' || v_session;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wallet:' || p_user::text));

  if exists (select 1 from public.wallet w where w.stripe_session_id = v_session) then
    return jsonb_build_object('ok', true, 'balance', public.clicktide_wallet_balance(p_user), 'duplicate', true);
  end if;

  v_result := public.clicktide_wallet_apply(p_user, p_amount, 'topup', 'Gift wallet top-up', p_payment_intent, v_key);
  if not coalesce((v_result ->> 'ok')::boolean, false) or coalesce((v_result ->> 'duplicate')::boolean, false) then
    return v_result;
  end if;

  update public.wallet
     set stripe_session_id        = v_session,
         stripe_payment_intent_id = nullif(btrim(coalesce(p_payment_intent, '')), ''),
         stripe_customer_id       = nullif(btrim(coalesce(p_customer, '')), ''),
         note                     = left(nullif(btrim(pg_catalog.regexp_replace(coalesce(p_note, ''), '[<>]', '', 'g')), ''), 500)
   where idempotency_key = v_key;

  select coalesce(sum(x.owed), 0) into v_owed
    from public.wallet_reversals x
   where x.user_id = p_user and x.owed > 0 and x.reinstated_at is null;

  if v_owed > 0 then
    v_pay := least(v_owed, (v_result ->> 'balance')::numeric);
    if v_pay > 0 then
      v_result := public.clicktide_wallet_apply(
        p_user, -v_pay, 'debt_recovery', 'Repaid: earlier top-up that was refunded or charged back',
        p_payment_intent, 'recover:' || v_session
      );
      if not coalesce((v_result ->> 'ok')::boolean, false) then
        raise exception 'wallet debt recovery failed: %', v_result ->> 'reason';
      end if;
      v_paid := v_pay;
      v_left := v_pay;
      for r in
        select x.reference, x.owed
          from public.wallet_reversals x
         where x.user_id = p_user and x.owed > 0 and x.reinstated_at is null
         order by x.created_at
         for update
      loop
        exit when v_left <= 0;
        v_take := least(v_left, r.owed);
        update public.wallet_reversals
           set owed = owed - v_take, recovered = recovered + v_take, updated_at = pg_catalog.now()
         where reference = r.reference;
        v_left := v_left - v_take;
      end loop;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'balance', (v_result ->> 'balance')::numeric, 'duplicate', false, 'recovered', v_paid);
end;
$$;

-- A Stripe refund (p_kind 'refund', p_reference = charge id, p_target = charge.amount_refunded)
-- or chargeback (p_kind 'dispute', p_reference = dispute id, p_target = dispute.amount) of a
-- top-up. p_target is cumulative, so replays and out-of-order deliveries take nothing twice.
create or replace function public.clicktide_wallet_reverse_topup(
  p_payment_intent text,
  p_reference text,
  p_kind text,
  p_target numeric,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pi       text := nullif(btrim(coalesce(p_payment_intent, '')), '');
  v_ref      text := nullif(btrim(coalesce(p_reference, '')), '');
  v_user     uuid;
  v_credited numeric;
  v_other    numeric;
  v_target   numeric;
  v_done     numeric := 0;
  v_reinst   timestamptz;
  v_delta    numeric;
  v_take     numeric;
  v_owed     numeric;
  v_result   jsonb;
begin
  if v_pi is null or v_ref is null or p_kind is null or p_kind not in ('refund', 'dispute')
     or p_target is null or not (p_target > 0 and p_target <= 1000000) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  select w.user_id, round(sum(w.amount::double precision)::numeric, 2)
    into v_user, v_credited
    from public.wallet w
   where w.stripe_payment_intent_id = v_pi and w.transaction_type = 'topup' and w.user_id is not null
   group by w.user_id
   limit 1;
  if v_user is null then
    return jsonb_build_object('ok', true, 'skipped', 'not_a_wallet_topup');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wallet:' || v_user::text));

  select x.reversed_total, x.reinstated_at into v_done, v_reinst
    from public.wallet_reversals x
   where x.reference = v_ref
   for update;
  if v_reinst is not null then
    return jsonb_build_object('ok', true, 'skipped', 'reinstated');
  end if;
  v_done := coalesce(v_done, 0);

  select coalesce(sum(x.reversed_total), 0) into v_other
    from public.wallet_reversals x
   where x.payment_intent = v_pi and x.reference <> v_ref and x.reinstated_at is null;

  v_target := least(round(p_target, 2), greatest(v_credited - v_other, 0));
  v_delta  := v_target - v_done;
  if v_delta <= 0 then
    return jsonb_build_object('ok', true, 'skipped', 'already_reversed', 'balance', public.clicktide_wallet_balance(v_user));
  end if;

  v_take := least(v_delta, greatest(public.clicktide_wallet_balance(v_user), 0));
  v_owed := v_delta - v_take;
  if v_take > 0 then
    v_result := public.clicktide_wallet_apply(
      v_user, -v_take, p_kind, coalesce(nullif(p_description, ''), 'Top-up reversed'), v_pi,
      p_kind || ':' || v_ref || ':' || v_target::text
    );
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      raise exception 'wallet reversal failed: %', v_result ->> 'reason';
    end if;
  end if;

  insert into public.wallet_reversals as x (reference, user_id, payment_intent, kind, reversed_total, taken, owed)
  values (v_ref, v_user, v_pi, p_kind, v_target, v_take, v_owed)
  on conflict (reference) do update
     set reversed_total = excluded.reversed_total,
         taken          = x.taken + excluded.taken,
         owed           = x.owed + excluded.owed,
         updated_at     = pg_catalog.now();

  return jsonb_build_object(
    'ok', true, 'user_id', v_user, 'reversed', v_delta, 'taken', v_take, 'owed', v_owed,
    'balance', public.clicktide_wallet_balance(v_user)
  );
end;
$$;

-- A dispute the business won: give back everything that dispute took (from the balance and
-- from later top-ups) and forget what is still owed. If the "won" event arrives before the
-- dispute was ever reversed, remember it so a late "created" event takes nothing.
create or replace function public.clicktide_wallet_reinstate(
  p_reference text,
  p_payment_intent text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref    text := nullif(btrim(coalesce(p_reference, '')), '');
  v_pi     text := nullif(btrim(coalesce(p_payment_intent, '')), '');
  v_user   uuid;
  v_kind   text;
  v_reinst timestamptz;
  v_back   numeric;
  v_result jsonb;
begin
  if v_ref is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  select x.user_id into v_user from public.wallet_reversals x where x.reference = v_ref;
  if v_user is null then
    if v_pi is null then
      return jsonb_build_object('ok', true, 'skipped', 'not_a_wallet_topup');
    end if;
    select w.user_id into v_user
      from public.wallet w
     where w.stripe_payment_intent_id = v_pi and w.transaction_type = 'topup' and w.user_id is not null
     limit 1;
    if v_user is null then
      return jsonb_build_object('ok', true, 'skipped', 'not_a_wallet_topup');
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wallet:' || v_user::text));

  select x.kind, x.reinstated_at, x.taken + x.recovered
    into v_kind, v_reinst, v_back
    from public.wallet_reversals x
   where x.reference = v_ref
   for update;

  if not found then
    insert into public.wallet_reversals (reference, user_id, payment_intent, kind, reinstated_at)
    values (v_ref, v_user, v_pi, 'dispute', pg_catalog.now())
    on conflict (reference) do nothing;
    return jsonb_build_object('ok', true, 'reinstated', 0, 'balance', public.clicktide_wallet_balance(v_user));
  end if;
  if v_kind <> 'dispute' then
    return jsonb_build_object('ok', true, 'skipped', 'not_a_dispute');
  end if;
  if v_reinst is not null then
    return jsonb_build_object('ok', true, 'skipped', 'already_reinstated', 'balance', public.clicktide_wallet_balance(v_user));
  end if;

  if v_back > 0 then
    v_result := public.clicktide_wallet_apply(
      v_user, v_back, 'dispute_reinstated', coalesce(nullif(p_description, ''), 'Dispute won: top-up restored'),
      v_pi, 'reinstate:' || v_ref
    );
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      raise exception 'wallet reinstatement failed: %', v_result ->> 'reason';
    end if;
  end if;

  update public.wallet_reversals
     set reinstated_at = pg_catalog.now(), owed = 0, updated_at = pg_catalog.now()
   where reference = v_ref;

  return jsonb_build_object('ok', true, 'reinstated', coalesce(v_back, 0), 'balance', public.clicktide_wallet_balance(v_user));
end;
$$;

-- 8. Who may call what (service role only; the trigger function needs no EXECUTE grant) --------

revoke all on function public.clicktide_wallet_balance(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_balance(uuid) to service_role;

revoke all on function public.clicktide_wallet_apply(uuid, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_apply(uuid, numeric, text, text, text, text) to service_role;

revoke all on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) to service_role;

revoke all on function public.clicktide_debit_gift_wallet(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_debit_gift_wallet(uuid, numeric, text, text) to service_role;

revoke all on function public.clicktide_wallet_ledger_guard() from public, anon, authenticated;

revoke all on function public.clicktide_wallet_credit_topup(uuid, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_credit_topup(uuid, numeric, text, text, text, text) to service_role;

revoke all on function public.clicktide_wallet_reverse_topup(text, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_reverse_topup(text, text, text, numeric, text) to service_role;

revoke all on function public.clicktide_wallet_reinstate(text, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_reinstate(text, text, text) to service_role;

notify pgrst, 'reload schema';
