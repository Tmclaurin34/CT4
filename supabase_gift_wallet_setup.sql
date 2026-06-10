alter table public.wallet
  add column if not exists transaction_type text default 'adjustment',
  add column if not exists note text,
  add column if not exists created_by uuid,
  add column if not exists stripe_session_id text,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_customer_id text,
  add column if not exists status text default 'posted',
  add column if not exists reference_id text;

create unique index if not exists wallet_stripe_session_id_unique
  on public.wallet(stripe_session_id)
  where stripe_session_id is not null;

create or replace function public.clicktide_wallet_balance(client_id uuid)
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select balance
    from public.wallet
    where user_id = client_id
    order by created_at desc
    limit 1
  ), 0)::numeric;
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
set search_path = public
as $$
declare
  current_balance numeric;
  new_balance numeric;
begin
  if client_id is null then
    raise exception 'Client id is required';
  end if;

  if debit_amount is null or debit_amount <= 0 then
    raise exception 'Debit amount must be greater than zero';
  end if;

  if auth.uid() <> client_id and not public.clicktide_can_manage_fulfillment(client_id) then
    raise exception 'Not allowed to debit this wallet';
  end if;

  select public.clicktide_wallet_balance(client_id) into current_balance;

  if current_balance < debit_amount then
    raise exception 'Insufficient gift wallet balance';
  end if;

  new_balance := current_balance - debit_amount;

  insert into public.wallet (
    user_id,
    "desc",
    amount,
    balance,
    transaction_type,
    status,
    reference_id
  ) values (
    client_id,
    coalesce(nullif(description, ''), 'Gift sent'),
    -debit_amount,
    new_balance,
    'gift_debit',
    'posted',
    reference
  );

  return new_balance;
end;
$$;

grant execute on function public.clicktide_wallet_balance(uuid) to authenticated;
grant execute on function public.clicktide_debit_gift_wallet(uuid, numeric, text, text) to authenticated;

create or replace function public.clicktide_debit_gift_wallet_server(
  client_id uuid,
  debit_amount numeric,
  description text,
  reference text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance numeric;
  new_balance numeric;
begin
  if client_id is null then
    raise exception 'Client id is required';
  end if;

  if debit_amount is null or debit_amount <= 0 then
    raise exception 'Debit amount must be greater than zero';
  end if;

  select public.clicktide_wallet_balance(client_id) into current_balance;

  if current_balance < debit_amount then
    raise exception 'Insufficient gift wallet balance';
  end if;

  new_balance := current_balance - debit_amount;

  insert into public.wallet (
    user_id,
    "desc",
    amount,
    balance,
    transaction_type,
    status,
    reference_id
  ) values (
    client_id,
    coalesce(nullif(description, ''), 'Gift sent'),
    -debit_amount,
    new_balance,
    'gift_debit',
    'posted',
    reference
  );

  return new_balance;
end;
$$;

revoke all on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) from public;
revoke all on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) from anon;
revoke all on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) from authenticated;
grant execute on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) to service_role;
