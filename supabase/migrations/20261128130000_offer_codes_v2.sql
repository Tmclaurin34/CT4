-- Offer codes v2 (2026-11-28): owner-verified codes for the counter AND for any website.
-- Builds on 20261128050000_offer_codes.sql.
--  * "Bring your own codes": the owner pastes codes they created in their own website's discount
--    settings (offer_code_pool). Clicktide hands one to each customer, never twice.
--  * Required tests: offers that need the counter wait until a TEST code was redeemed on one of
--    the business's counter devices (offers_store_verified_at); offers that need the website wait
--    until the owner confirmed one of their codes worked at their own checkout (offers_web_verified_at).
--  * Dashboard backup: the owner can redeem a code from their own (two-step) session.

alter table public.offer_codes add column if not exists is_test boolean not null default false;
alter table public.clicktide add column if not exists offers_store_verified_at timestamptz;
alter table public.clicktide add column if not exists offers_web_verified_at timestamptz;
alter table public.campaigns add column if not exists reward_where text;
do $$ begin
  alter table public.campaigns add constraint campaigns_reward_where_chk check (reward_where is null or reward_where in ('store','web','both'));
exception when duplicate_object then null; end $$;

create table if not exists public.offer_code_pool (
  id bigserial primary key,
  user_id uuid not null,
  code text not null,
  status text not null default 'available' check (status in ('available','assigned','test','removed')),
  customer_id bigint,
  campaign_id bigint,
  issue_key text unique,
  assigned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code)
);
create index if not exists offer_code_pool_available on public.offer_code_pool (user_id, id) where status = 'available';
alter table public.offer_code_pool enable row level security;
revoke all on public.offer_code_pool from anon, authenticated;
revoke all on sequence public.offer_code_pool_id_seq from anon, authenticated;

-- Owner: add codes (one per line / list). Keeps letters, digits, - and _ ; 3-40 chars.
create or replace function public.clicktide_offer_pool_add(p_codes text[])
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_user uuid := auth.uid(); c text; added int := 0; skipped int := 0; bad int := 0;
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  if coalesce(array_length(p_codes,1),0) > 2000 then raise exception 'add up to 2,000 codes at a time' using errcode='22023'; end if;
  foreach c in array coalesce(p_codes, '{}') loop
    c := btrim(c);
    if c = '' then continue; end if;
    if c !~ '^[A-Za-z0-9_-]{3,40}$' then bad := bad + 1; continue; end if;
    insert into public.offer_code_pool(user_id, code) values (v_user, c) on conflict (user_id, code) do nothing;
    if found then added := added + 1; else skipped := skipped + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'duplicates', skipped, 'invalid', bad);
end $$;

-- Owner: how many codes are left, plus verification + device status.
create or replace function public.clicktide_offer_status()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  return jsonb_build_object(
    'pool_available', (select count(*) from public.offer_code_pool where user_id=v_user and status='available'),
    'pool_assigned',  (select count(*) from public.offer_code_pool where user_id=v_user and status='assigned'),
    'devices',        (select count(*) from public.redeem_devices where user_id=v_user and revoked_at is null),
    'store_verified_at', (select offers_store_verified_at from public.clicktide where user_id=v_user order by id limit 1),
    'web_verified_at',   (select offers_web_verified_at from public.clicktide where user_id=v_user order by id limit 1),
    'codes_used',     (select count(*) from public.offer_codes where user_id=v_user and status='used' and not is_test),
    'codes_open',     (select count(*) from public.offer_codes where user_id=v_user and status='open' and not is_test));
end $$;

-- Owner: issue a TEST counter code (no customer). Redeeming it on a counter device verifies the counter.
create or replace function public.clicktide_offer_test_issue()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_user uuid := auth.uid(); r jsonb; v_code text;
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  if not public.clicktide_rate_limit_hit('offer_test:'||v_user::text, 3600, 20) then raise exception 'too many test codes, try again later' using errcode='54000'; end if;
  r := public.clicktide_offer_code_issue(v_user, null, null, 'TEST CODE: works like a real "$10 off"', null, 0, ((now() at time zone 'UTC')::date + 1), null);
  v_code := r->>'code';
  update public.offer_codes set is_test = true where code = v_code;
  return jsonb_build_object('code', v_code);
end $$;

-- Owner: pick one of their own codes to try at their checkout.
create or replace function public.clicktide_offer_pool_test()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_user uuid := auth.uid(); v_id bigint; v_code text;
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  select id, code into v_id, v_code from public.offer_code_pool where user_id=v_user and status='test' order by id limit 1;
  if v_id is null then
    select id, code into v_id, v_code from public.offer_code_pool where user_id=v_user and status='available' order by id limit 1 for update skip locked;
    if v_id is null then return jsonb_build_object('code', null); end if;
    update public.offer_code_pool set status='test' where id=v_id;
  end if;
  return jsonb_build_object('code', v_code);
end $$;

-- Owner: did the test code work at their checkout? Yes = website offers can go out.
-- The tried code is never handed to a customer (it may have been used in the test).
create or replace function public.clicktide_offer_pool_confirm(p_worked boolean)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  update public.offer_code_pool set status='removed' where user_id=v_user and status='test';
  if p_worked then update public.clicktide set offers_web_verified_at = now() where user_id=v_user; end if;
  return jsonb_build_object('verified', p_worked);
end $$;

-- Engine (service role): give this customer one of the business's own website codes.
-- Same issue_key returns the same code (retries never burn a second code). null = none left.
create or replace function public.clicktide_offer_pool_assign(p_user uuid, p_customer bigint, p_campaign bigint, p_issue_key text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id bigint; v_code text;
begin
  if p_issue_key is not null then
    select code into v_code from public.offer_code_pool where issue_key=p_issue_key;
    if v_code is not null then return jsonb_build_object('code', v_code, 'reused', true); end if;
  end if;
  select id, code into v_id, v_code from public.offer_code_pool where user_id=p_user and status='available' order by id limit 1 for update skip locked;
  if v_id is null then return jsonb_build_object('code', null, 'empty', true); end if;
  update public.offer_code_pool set status='assigned', customer_id=p_customer, campaign_id=p_campaign, issue_key=p_issue_key, assigned_at=now() where id=v_id;
  return jsonb_build_object('code', v_code, 'reused', false);
end $$;

-- Owner (dashboard backup): redeem a counter code from their own session, same rules as a device.
create or replace function public.clicktide_offer_code_redeem_owner(p_code text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_user uuid := auth.uid(); v_row public.offer_codes%rowtype; v_name text;
begin
  if v_user is null then raise exception 'sign in first' using errcode='42501'; end if;
  if not public.clicktide_owner_mfa_ok() then raise exception 'two-step verification required' using errcode='42501'; end if;
  if not public.clicktide_rate_limit_hit('offer_owner_redeem:'||v_user::text, 600, 120) then return jsonb_build_object('result','slow_down'); end if;
  select * into v_row from public.offer_codes where code = upper(btrim(p_code)) for update;
  if not found or v_row.user_id <> v_user then return jsonb_build_object('result','not_for_this_business'); end if;
  select cu.name into v_name from public.customers cu where cu.id = v_row.customer_id and cu.user_id = v_row.user_id;
  if v_row.status = 'used' then return jsonb_build_object('result','already_used','used_at',v_row.used_at,'customer',v_name); end if;
  if v_row.status = 'closed' then return jsonb_build_object('result','closed','customer',v_name); end if;
  if v_row.status = 'expired' or (v_row.expires_on is not null and v_row.expires_on < (now() at time zone 'UTC')::date) then
    update public.offer_codes set status='expired' where id=v_row.id and status='open';
    return jsonb_build_object('result','expired','expires_on',v_row.expires_on,'customer',v_name);
  end if;
  update public.offer_codes set status='used', used_at=now(), used_via='scan', undo_until=now()+interval '2 minutes' where id=v_row.id and status='open';
  if v_row.is_test then update public.clicktide set offers_store_verified_at=now() where user_id=v_user; end if;
  return jsonb_build_object('result','redeemed','customer',v_name,'offer',v_row.offer,'credit',v_row.credit_amount,'min_spend',v_row.min_spend,'test',v_row.is_test);
end $$;

revoke all on function public.clicktide_offer_pool_add(text[]) from public, anon;
revoke all on function public.clicktide_offer_status() from public, anon;
revoke all on function public.clicktide_offer_test_issue() from public, anon;
revoke all on function public.clicktide_offer_pool_test() from public, anon;
revoke all on function public.clicktide_offer_pool_confirm(boolean) from public, anon;
revoke all on function public.clicktide_offer_pool_assign(uuid, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.clicktide_offer_code_redeem_owner(text) from public, anon;
grant execute on function public.clicktide_offer_pool_add(text[]) to authenticated;
grant execute on function public.clicktide_offer_status() to authenticated;
grant execute on function public.clicktide_offer_test_issue() to authenticated;
grant execute on function public.clicktide_offer_pool_test() to authenticated;
grant execute on function public.clicktide_offer_pool_confirm(boolean) to authenticated;
grant execute on function public.clicktide_offer_pool_assign(uuid, bigint, bigint, text) to service_role;
grant execute on function public.clicktide_offer_code_redeem_owner(text) to authenticated;
