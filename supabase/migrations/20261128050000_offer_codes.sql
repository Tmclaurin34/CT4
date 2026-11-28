-- One-time offer codes (store credit / perks) + staff redeem devices.
-- Plan: outputs/gift-intelligence/scope.md ("Codes can't be reused", "Easy for staff").
-- Applied 2026-11-28 (owner approved offer codes); two-step checks added on the owner functions.
--
-- * Each customer gets their OWN code (e.g. JUNE-7K3Q-MX) for a campaign's offer. It works once.
-- * Staff redeem it by opening the code's link on a device the owner set up ("redeem device").
--   Opening = redeeming (one step). Undo is allowed for 2 minutes.
-- * Safety net: an open code closes itself when POS sync shows the customer bought again,
--   scanned or not (clicktide_offer_codes_close_on_purchase, run after each sync / hourly).
-- * Codes are random from a 30-character alphabet without 0/O/1/I/L/U (8 random chars, ~6.6e11
--   combinations) plus a short business prefix, so they can't be guessed.
-- * Everything is server-only (RLS on, no policies, service_role execute). The owner's dashboard
--   reads its own codes through clicktide_offer_codes_for_owner, which checks auth.uid().

create table if not exists public.offer_codes (
  id bigserial primary key,
  user_id uuid not null,                       -- the business
  customer_id bigint,
  campaign_id bigint,
  code text not null unique,
  issue_key text unique,                       -- campaign:customer:date, so a retry reuses the code
  offer text not null,                         -- e.g. "$10 off your next visit"
  credit_amount numeric,                       -- dollars, null for a perk
  min_spend numeric not null default 0,
  expires_on date,
  status text not null default 'open' check (status in ('open', 'used', 'closed', 'expired')),
  used_at timestamptz,
  used_via text check (used_via in ('scan', 'online', 'pos_sync')),
  used_device bigint,
  undo_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists offer_codes_open_by_business on public.offer_codes (user_id, customer_id) where status = 'open';

create table if not exists public.redeem_devices (
  id bigserial primary key,
  user_id uuid not null,
  token_hash text not null unique,             -- sha256 of the device token; the token itself stays on the device
  name text not null default 'Counter device',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);


-- Campaign settings for one-time codes (digital_gift campaigns).
alter table public.campaigns
  add column if not exists reward_unique boolean not null default false,  -- give each customer their own one-time code
  add column if not exists reward_credit numeric,                         -- dollars off (null for a perk)
  add column if not exists reward_min_spend numeric;                      -- minimum purchase to use it

alter table public.offer_codes enable row level security;
alter table public.redeem_devices enable row level security;
revoke all on public.offer_codes, public.redeem_devices from anon, authenticated;
revoke all on sequence public.offer_codes_id_seq, public.redeem_devices_id_seq from anon, authenticated;

-- Random code part from an unambiguous alphabet.
create or replace function public.clicktide_offer_code_random(p_len integer)
returns text
language plpgsql
volatile
set search_path to ''
as $$
declare
  a constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';  -- 30 chars: no 0 O 1 I L U
  b bytea := extensions.gen_random_bytes(p_len);
  out text := '';
  i integer;
begin
  for i in 0 .. p_len - 1 loop
    out := out || substr(a, 1 + (get_byte(b, i) % 30), 1);
  end loop;
  return out;
end;
$$;

-- Issue (or re-use) a customer's code. Same issue_key returns the same code.
create or replace function public.clicktide_offer_code_issue(
  p_user uuid, p_customer bigint, p_campaign bigint, p_offer text,
  p_credit numeric, p_min_spend numeric, p_expires date, p_issue_key text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_prefix text;
  v_code text;
  v_row public.offer_codes%rowtype;
  tries integer := 0;
begin
  if p_user is null or coalesce(btrim(p_offer), '') = '' then
    raise exception 'business and offer are required';
  end if;
  if p_issue_key is not null then
    select * into v_row from public.offer_codes where issue_key = p_issue_key;
    if found then
      return jsonb_build_object('code', v_row.code, 'reused', true);
    end if;
  end if;
  select upper(regexp_replace(coalesce(c.business_name, ''), '[^A-Za-z]', '', 'g'))
    into v_prefix from public.clicktide c where c.user_id = p_user order by c.id limit 1;
  v_prefix := left(coalesce(nullif(v_prefix, ''), 'CT'), 4);
  loop
    tries := tries + 1;
    v_code := v_prefix || '-' || public.clicktide_offer_code_random(4) || '-' || public.clicktide_offer_code_random(4);
    begin
      insert into public.offer_codes (user_id, customer_id, campaign_id, code, issue_key, offer, credit_amount, min_spend, expires_on)
      values (p_user, p_customer, p_campaign, v_code, p_issue_key, left(btrim(p_offer), 160),
              p_credit, greatest(coalesce(p_min_spend, 0), 0), p_expires);
      return jsonb_build_object('code', v_code, 'reused', false);
    exception when unique_violation then
      if p_issue_key is not null then
        select * into v_row from public.offer_codes where issue_key = p_issue_key;
        if found then return jsonb_build_object('code', v_row.code, 'reused', true); end if;
      end if;
      if tries >= 5 then raise; end if;
    end;
  end loop;
end;
$$;

-- Customer-facing view of a code (the claim link). Shows only the offer, the business and
-- the customer's FIRST name. Never the full name, phone, email or address.
create or replace function public.clicktide_offer_code_public(p_code text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'found', true,
    'business', c.business_name,
    'first_name', split_part(coalesce(cu.name, ''), ' ', 1),
    'offer', o.offer,
    'credit', o.credit_amount,
    'min_spend', o.min_spend,
    'expires_on', o.expires_on,
    'status', case when o.status = 'open' and o.expires_on is not null and o.expires_on < (now() at time zone 'UTC')::date then 'expired' else o.status end)
  from public.offer_codes o
  left join public.clicktide c on c.user_id = o.user_id
  left join public.customers cu on cu.id = o.customer_id and cu.user_id = o.user_id
  where o.code = upper(btrim(p_code))
  limit 1;
$$;

-- Register a counter device for the signed-in owner. Returns the raw token ONCE; only its
-- hash is stored. Called from the dashboard with the owner's own session.
create or replace function public.clicktide_redeem_device_register(p_name text default 'Counter device')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user uuid := auth.uid();
  v_token text;
begin
  if v_user is null then raise exception 'sign in first'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required'; end if;
  if not exists (select 1 from public.clicktide c where c.user_id = v_user) then
    raise exception 'no business on this account';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.redeem_devices (user_id, token_hash, name)
  values (v_user, encode(extensions.digest(v_token, 'sha256'), 'hex'), left(coalesce(nullif(btrim(p_name), ''), 'Counter device'), 60));
  return jsonb_build_object('token', v_token);
end;
$$;

-- Redeem: the staff device opened the code. Atomic open -> used. Returns what staff should do.
create or replace function public.clicktide_offer_code_redeem(p_device_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_dev public.redeem_devices%rowtype;
  v_row public.offer_codes%rowtype;
  v_name text;
begin
  select * into v_dev from public.redeem_devices
   where token_hash = encode(extensions.digest(coalesce(p_device_token, ''), 'sha256'), 'hex') and revoked_at is null;
  if not found then
    return jsonb_build_object('result', 'not_a_staff_device');
  end if;
  update public.redeem_devices set last_used_at = now() where id = v_dev.id;

  select * into v_row from public.offer_codes where code = upper(btrim(p_code)) for update;
  if not found or v_row.user_id <> v_dev.user_id then
    return jsonb_build_object('result', 'not_for_this_business');
  end if;
  select cu.name into v_name from public.customers cu where cu.id = v_row.customer_id and cu.user_id = v_row.user_id;

  if v_row.status = 'used' then
    return jsonb_build_object('result', 'already_used', 'used_at', v_row.used_at, 'customer', v_name);
  end if;
  if v_row.status = 'closed' then
    return jsonb_build_object('result', 'closed', 'customer', v_name);
  end if;
  if v_row.status = 'expired' or (v_row.expires_on is not null and v_row.expires_on < (now() at time zone 'UTC')::date) then
    update public.offer_codes set status = 'expired' where id = v_row.id and status = 'open';
    return jsonb_build_object('result', 'expired', 'expires_on', v_row.expires_on, 'customer', v_name);
  end if;

  update public.offer_codes
     set status = 'used', used_at = now(), used_via = 'scan', used_device = v_dev.id, undo_until = now() + interval '2 minutes'
   where id = v_row.id and status = 'open';
  -- a TEST code redeemed on this business's own device proves the counter works
  if coalesce(v_row.is_test, false) then update public.clicktide set offers_store_verified_at = now() where user_id = v_dev.user_id; end if;
  return jsonb_build_object('result', 'redeemed', 'customer', v_name, 'offer', v_row.offer, 'test', coalesce(v_row.is_test, false),
                            'credit', v_row.credit_amount, 'min_spend', v_row.min_spend,
                            'undo_until', now() + interval '2 minutes');
end;
$$;

-- Undo a scan within 2 minutes, from the same business's device.
create or replace function public.clicktide_offer_code_undo(p_device_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.redeem_devices
   where token_hash = encode(extensions.digest(coalesce(p_device_token, ''), 'sha256'), 'hex') and revoked_at is null;
  if v_user is null then return jsonb_build_object('result', 'not_a_staff_device'); end if;
  update public.offer_codes
     set status = 'open', used_at = null, used_via = null, used_device = null, undo_until = null
   where code = upper(btrim(p_code)) and user_id = v_user and status = 'used'
     and used_via = 'scan' and undo_until > now();
  if found then return jsonb_build_object('result', 'undone'); end if;
  return jsonb_build_object('result', 'too_late');
end;
$$;

-- Safety net: close open codes for customers who bought again after the code was issued.
-- Run after POS sync (and hourly). p_user null = every business.
create or replace function public.clicktide_offer_codes_close_on_purchase(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  n integer;
begin
  update public.offer_codes o
     set status = 'closed', used_at = coalesce(o.used_at, now()), used_via = 'pos_sync'
   where o.status = 'open'
     and (p_user is null or o.user_id = p_user)
     and o.customer_id is not null
     and exists (select 1 from public.customer_visits v
                  where v.user_id = o.user_id and v.customer_id = o.customer_id
                    and coalesce(v.last_at, v.first_at, v.visited_on::timestamptz) > o.created_at);
  get diagnostics n = row_count;
  update public.offer_codes set status = 'expired'
   where status = 'open' and expires_on is not null and expires_on < (now() at time zone 'UTC')::date
     and (p_user is null or user_id = p_user);
  return n;
end;
$$;

-- The owner's own codes (dashboard results). Uses the caller's session.
create or replace function public.clicktide_offer_codes_for_owner(p_limit integer default 200)
returns setof jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object('code', o.code, 'customer', cu.name, 'offer', o.offer, 'status', o.status,
                            'used_via', o.used_via, 'used_at', o.used_at, 'created_at', o.created_at)
    from public.offer_codes o
    left join public.customers cu on cu.id = o.customer_id and cu.user_id = o.user_id
   where o.user_id = auth.uid() and public.clicktide_owner_mfa_ok()
   order by o.created_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

revoke all on function public.clicktide_offer_code_random(integer) from public, anon, authenticated;
revoke all on function public.clicktide_offer_code_issue(uuid, bigint, bigint, text, numeric, numeric, date, text) from public, anon, authenticated;
revoke all on function public.clicktide_offer_code_public(text) from public, anon, authenticated;
revoke all on function public.clicktide_offer_code_redeem(text, text) from public, anon, authenticated;
revoke all on function public.clicktide_offer_code_undo(text, text) from public, anon, authenticated;
revoke all on function public.clicktide_offer_codes_close_on_purchase(uuid) from public, anon, authenticated;
revoke all on function public.clicktide_redeem_device_register(text) from public, anon;
revoke all on function public.clicktide_offer_codes_for_owner(integer) from public, anon;
grant execute on function public.clicktide_offer_code_issue(uuid, bigint, bigint, text, numeric, numeric, date, text) to service_role;
grant execute on function public.clicktide_offer_code_public(text) to service_role;
grant execute on function public.clicktide_offer_code_redeem(text, text) to service_role;
grant execute on function public.clicktide_offer_code_undo(text, text) to service_role;
grant execute on function public.clicktide_offer_codes_close_on_purchase(uuid) to service_role;
grant execute on function public.clicktide_redeem_device_register(text) to authenticated;
grant execute on function public.clicktide_offer_codes_for_owner(integer) to authenticated;
