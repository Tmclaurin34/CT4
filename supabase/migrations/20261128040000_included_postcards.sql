-- Included postcards: each paid plan gets a monthly allowance of free mailed postcards
-- (Local 10, Growth 30, Scale 75, as the plan cards promise). The campaign engine claims a
-- free slot before charging the wallet; only when the month's allowance is used up does a
-- postcard cost $1.50 (wallet, or Shopify usage for Shopify-billed stores).
--
-- Rules:
-- * Only for a subscription that is ACTIVE or PAST_DUE. Trials and development stores get
--   no free postcards (each one costs Clicktide real postage); they keep today's behaviour.
-- * The month is the UTC calendar month, the same as clicktide_sms_usage.
-- * One slot per idempotency key (the engine's campaign:customer:postcard:date key), so a
--   retry never uses a second slot. A postcard Lob refuses is RELEASED: it stops counting
--   against the allowance, but the key is remembered so the same card isn't retried today
--   (mirrors the wallet path's "already attempted and refunded today").
-- * A per-business advisory lock makes the count-then-claim atomic.
-- Server-only: the table has RLS with no policies; the functions run as SECURITY DEFINER
-- and are executable by service_role only.

create table if not exists public.postcard_free_uses (
  id bigserial primary key,
  user_id uuid not null,
  month date not null,                 -- first day of the UTC month
  pay_key text not null unique,        -- the engine's idempotency key for this card
  status text not null default 'used' check (status in ('used', 'released')),
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists postcard_free_uses_user_month on public.postcard_free_uses (user_id, month) where status = 'used';
alter table public.postcard_free_uses enable row level security;
revoke all on public.postcard_free_uses from anon, authenticated;
revoke all on sequence public.postcard_free_uses_id_seq from anon, authenticated;

-- The monthly allowance for a business right now (0 = no free postcards).
create or replace function public.clicktide_postcard_allowance(p_user uuid)
returns integer
language sql
stable
security definer
set search_path to ''
as $$
  select case
           when lower(btrim(coalesce(c.stripe_subscription_status, ''))) not in ('active', 'past_due') then 0
           when lower(btrim(coalesce(c.plan, ''))) = 'local'  then 10
           when lower(btrim(coalesce(c.plan, ''))) = 'growth' then 30
           when lower(btrim(coalesce(c.plan, ''))) = 'scale'  then 75
           else 0
         end
    from public.clicktide c
   where c.user_id = p_user
   order by (c.stripe_subscription_id is not null) desc, c.id
   limit 1;
$$;

-- Claim one free postcard for this card's key.
-- Returns {free:true, used, allowance}            a slot was claimed (or this key already holds one)
--         {free:false, released:true}             this key was claimed then released today: skip
--         {free:false, used, allowance}           allowance used up (or none): charge as usual
create or replace function public.clicktide_postcard_claim_free(p_user uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_allow integer;
  v_used integer;
  v_row public.postcard_free_uses%rowtype;
begin
  if p_user is null or coalesce(btrim(p_key), '') = '' then
    raise exception 'user and key are required';
  end if;
  perform pg_advisory_xact_lock(hashtext('ct_pcfree:' || p_user::text));

  select * into v_row from public.postcard_free_uses where pay_key = p_key;
  if found then
    if v_row.status = 'released' then
      return jsonb_build_object('free', false, 'released', true);
    end if;
    return jsonb_build_object('free', true, 'duplicate', true);
  end if;

  v_allow := coalesce(public.clicktide_postcard_allowance(p_user), 0);
  select count(*) into v_used from public.postcard_free_uses
   where user_id = p_user and month = v_month and status = 'used';
  if v_used >= v_allow then
    return jsonb_build_object('free', false, 'used', v_used, 'allowance', v_allow);
  end if;

  insert into public.postcard_free_uses (user_id, month, pay_key) values (p_user, v_month, p_key);
  return jsonb_build_object('free', true, 'used', v_used + 1, 'allowance', v_allow);
end;
$$;

-- Give a slot back when Lob refused the card (it was never mailed).
create or replace function public.clicktide_postcard_release_free(p_user uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
begin
  update public.postcard_free_uses
     set status = 'released', released_at = now()
   where pay_key = p_key and user_id = p_user and status = 'used';
  return found;
end;
$$;

-- How many free postcards a business has used this month, and its allowance (for the dashboard).
create or replace function public.clicktide_postcard_free_usage(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'used', (select count(*) from public.postcard_free_uses u
              where u.user_id = p_user and u.status = 'used'
                and u.month = date_trunc('month', now() at time zone 'UTC')::date),
    'allowance', coalesce(public.clicktide_postcard_allowance(p_user), 0));
$$;

revoke all on function public.clicktide_postcard_allowance(uuid) from public, anon, authenticated;
revoke all on function public.clicktide_postcard_claim_free(uuid, text) from public, anon, authenticated;
revoke all on function public.clicktide_postcard_release_free(uuid, text) from public, anon, authenticated;
revoke all on function public.clicktide_postcard_free_usage(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_postcard_allowance(uuid) to service_role;
grant execute on function public.clicktide_postcard_claim_free(uuid, text) to service_role;
grant execute on function public.clicktide_postcard_release_free(uuid, text) to service_role;
grant execute on function public.clicktide_postcard_free_usage(uuid) to service_role;
