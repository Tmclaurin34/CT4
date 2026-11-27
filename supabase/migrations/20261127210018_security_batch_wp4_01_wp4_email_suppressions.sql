-- WP4 (email), contract C2: per-business email opt-outs.
--
-- Idempotent and additive, safe to re-run. It adds one table, an address-normalising
-- helper, two indexes on public.customers, two triggers and four service-role RPCs, and
-- copies the opt-outs that already exist into the new table. No existing row is
-- changed or deleted.
--
-- Apply this BEFORE deploying the WP4 functions: email-unsubscribe, send-customer-email
-- and resend-webhook read and write through it, and send-customer-email refuses to send
-- (fails closed) while it is missing.
--
-- email_suppressions.reason values written by WP4:
--   unsubscribe         per-business unsubscribe link (GET or RFC 8058 one-click POST).
--                       The ONLY reason a re-subscribe can undo; any other opt-out of the
--                       same address replaces it.
--   legacy_unsubscribe  an older address-only link: written for every business that
--                       had the address.
--   complaint           spam report reported by Resend (resend-webhook)
--   bounce              hard bounce reported by Resend. Blocks sending but does not mark
--                       the customer unsubscribed, so an owner can fix a typo'd address.
--   owner               the business itself marked the customer unsubscribed
--   backfill            opt-outs that existed before this table
-- Other packages should write through public.clicktide_email_optout(user, email, reason)
-- with their own reason (e.g. 'pos_optout'). A direct insert also works: email_lower is
-- normalised on write, and a row whose address normalises to '' is skipped, not refused.

-- ---------------------------------------------------------------------------
-- 0. One address normalisation for every comparison: lower-case, and trim exactly the
--    characters JavaScript's String.prototype.trim() removes (btrim() removes only
--    spaces, so a stored 'a@b.com\r' from a CRLF CSV would never match).
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_email_norm(p_email text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    coalesce(p_email, ''),
    '^[[:space:]   -     　﻿]+|[[:space:]   -     　﻿]+$',
    '', 'g'))
$$;

-- Pure string helper. Index expressions check EXECUTE as the writing role, so every
-- role that inserts customers needs it.
grant execute on function public.clicktide_email_norm(text) to public;

-- ---------------------------------------------------------------------------
-- 1. The suppression list. Owners may read their own rows; only the service role
--    writes (the customers trigger below writes as the table owner).
-- ---------------------------------------------------------------------------
create table if not exists public.email_suppressions (
  user_id     uuid not null,
  email_lower text not null,
  reason      text,
  created_at  timestamptz not null default now(),
  primary key (user_id, email_lower)
);

comment on table public.email_suppressions is
  'C2: addresses a business must never email again (per business user_id). Senders skip an address listed here for that business OR any customer row with email_unsubscribed_at set (public.clicktide_email_send_block does both). Service role writes only; write through public.clicktide_email_optout.';

alter table public.email_suppressions enable row level security;
revoke all on table public.email_suppressions from public, anon, authenticated;
grant select on table public.email_suppressions to authenticated;
grant select, insert, update, delete on table public.email_suppressions to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'email_suppressions'
       and policyname = 'email_suppressions_owner_select'
  ) then
    create policy email_suppressions_owner_select on public.email_suppressions
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

create or replace function public.clicktide_email_suppressions_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email_lower := public.clicktide_email_norm(new.email_lower);
  if new.email_lower = '' then
    -- Skip the row instead of raising, so one blank address can't fail a caller's batch.
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.clicktide_email_suppressions_normalize() from public, anon, authenticated;

create or replace trigger email_suppressions_normalize
  before insert or update of email_lower
  on public.email_suppressions
  for each row execute function public.clicktide_email_suppressions_normalize();

-- ---------------------------------------------------------------------------
-- 2. Carry over every opt-out that exists today (they were global, flag-only).
-- ---------------------------------------------------------------------------
insert into public.email_suppressions (user_id, email_lower, reason, created_at)
select c.user_id, public.clicktide_email_norm(c.email), 'backfill', min(c.email_unsubscribed_at)
  from public.customers c
 where c.user_id is not null
   and c.email_unsubscribed_at is not null
   and public.clicktide_email_norm(c.email) <> ''
 group by c.user_id, public.clicktide_email_norm(c.email)
on conflict (user_id, email_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Exact, case-insensitive address lookups (the RPCs and the trigger match
--    clicktide_email_norm(email) = ..., never LIKE/ILIKE).
-- ---------------------------------------------------------------------------
create index if not exists customers_user_email_norm_idx
  on public.customers (user_id, (public.clicktide_email_norm(email)));
create index if not exists customers_email_norm_idx
  on public.customers ((public.clicktide_email_norm(email)));

-- ---------------------------------------------------------------------------
-- 4. Opt-outs stick.
--    * Browser writers (owners, partners, staff sessions) can set
--      email_unsubscribed_at / sms_unsubscribed_at but never clear or change them.
--    * A customer row whose address is on its business's suppression list (other than
--      a bounce) is flagged unsubscribed however it arrives: CSV import, POS sync,
--      delete and re-add, or an edited email.
--    * When a business marks a customer unsubscribed itself, the address is added to
--      its suppression list as 'owner' (replacing a recipient's 'unsubscribe' or a
--      'bounce'), so neither deleting and re-adding the customer nor the recipient's
--      re-subscribe undoes it. Flagging a re-imported suppressed address is not an
--      owner opt-out and leaves the existing reason alone.
--    Trusted writers (service role, SQL editor, migrations, pg_cron) may clear flags;
--    that is how a recipient's own re-subscribe is applied.
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_customers_optout_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims    jsonb   := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role      text    := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_trusted   boolean := coalesce(v_role = 'service_role', false)
                         or (v_role is null and session_user <> 'authenticator');
  v_email     text    := public.clicktide_email_norm(new.email);
  v_owner_set boolean := false;
begin
  if tg_op = 'UPDATE' and not v_trusted then
    if old.email_unsubscribed_at is not null then
      new.email_unsubscribed_at := old.email_unsubscribed_at;
    end if;
    if old.sms_unsubscribed_at is not null then
      new.sms_unsubscribed_at := old.sms_unsubscribed_at;
    end if;
  end if;

  if new.user_id is not null and v_email <> '' then
    -- Decided before the re-flag below, so only the writer's own opt-out counts.
    v_owner_set := not v_trusted
                   and new.email_unsubscribed_at is not null
                   and (tg_op = 'INSERT' or old.email_unsubscribed_at is null);

    if new.email_unsubscribed_at is null and exists (
      select 1
        from public.email_suppressions s
       where s.user_id = new.user_id
         and s.email_lower = v_email
         and s.reason is distinct from 'bounce'
    ) then
      new.email_unsubscribed_at := now();
    end if;

    if v_owner_set then
      insert into public.email_suppressions as s (user_id, email_lower, reason)
      values (new.user_id, v_email, 'owner')
      on conflict (user_id, email_lower) do update
         set reason = excluded.reason
       where s.reason in ('unsubscribe', 'bounce');
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.clicktide_customers_optout_guard() from public, anon, authenticated;

create or replace trigger customers_optout_guard
  before insert or update of email, email_unsubscribed_at, sms_unsubscribed_at, user_id
  on public.customers
  for each row execute function public.clicktide_customers_optout_guard();

-- ---------------------------------------------------------------------------
-- 5. Service-role RPCs used by email-unsubscribe, resend-webhook and the senders.
--    Upgrade rule shared by every writer: a recipient's 'unsubscribe' or a 'bounce'
--    is replaced by any other reason (complaint, owner, legacy link, POS opt-out...),
--    so a re-subscribe can only ever undo the recipient's own per-business opt-out.
-- ---------------------------------------------------------------------------

-- Opt one address out of ONE business. Returns the number of customer rows newly
-- flagged (0 for a bounce, which only blocks sending).
create or replace function public.clicktide_email_optout(
  p_user   uuid,
  p_email  text,
  p_reason text default 'unsubscribe'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text    := public.clicktide_email_norm(p_email);
  v_reason text    := left(coalesce(nullif(btrim(p_reason), ''), 'unsubscribe'), 40);
  v_rows   integer := 0;
begin
  if p_user is null or v_email = '' then
    return 0;
  end if;

  insert into public.email_suppressions as s (user_id, email_lower, reason)
  values (p_user, v_email, v_reason)
  on conflict (user_id, email_lower) do update
     set reason = excluded.reason
   where excluded.reason not in ('unsubscribe', 'bounce')
     and s.reason in ('unsubscribe', 'bounce');

  if v_reason <> 'bounce' then
    update public.customers c
       set email_unsubscribed_at = now()
     where c.user_id = p_user
       and public.clicktide_email_norm(c.email) = v_email
       and c.email_unsubscribed_at is null;
    get diagnostics v_rows = row_count;
  end if;

  return v_rows;
end;
$$;

revoke all on function public.clicktide_email_optout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_email_optout(uuid, text, text) to service_role;

-- Legacy (address-only) links: opt the address out of EVERY business that has it.
-- Returns the number of customer rows newly flagged.
create or replace function public.clicktide_email_optout_everywhere(
  p_email  text,
  p_reason text default 'legacy_unsubscribe'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text    := public.clicktide_email_norm(p_email);
  v_reason text    := left(coalesce(nullif(btrim(p_reason), ''), 'legacy_unsubscribe'), 40);
  v_rows   integer := 0;
begin
  if v_email = '' then
    return 0;
  end if;

  insert into public.email_suppressions as s (user_id, email_lower, reason)
  select distinct c.user_id, v_email, v_reason
    from public.customers c
   where c.user_id is not null
     and public.clicktide_email_norm(c.email) = v_email
  on conflict (user_id, email_lower) do update
     set reason = excluded.reason
   where excluded.reason not in ('unsubscribe', 'bounce')
     and s.reason in ('unsubscribe', 'bounce');

  update public.customers c
     set email_unsubscribed_at = now()
   where public.clicktide_email_norm(c.email) = v_email
     and c.email_unsubscribed_at is null;
  get diagnostics v_rows = row_count;

  return v_rows;
end;
$$;

revoke all on function public.clicktide_email_optout_everywhere(text, text) from public, anon, authenticated;
grant execute on function public.clicktide_email_optout_everywhere(text, text) to service_role;

-- The recipient's own undo, for ONE business. It undoes only that business's
-- 'unsubscribe' row and the customer flags set from that moment on. A complaint,
-- bounce, legacy link, the business's own opt-out, a pre-existing opt-out, or a flag
-- some other flow set before the unsubscribe (SMS STOP, POS import, survey) stays,
-- and then nothing is changed. Returns true when the address can receive that
-- business's email again.
create or replace function public.clicktide_email_resubscribe(
  p_user  uuid,
  p_email text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text := public.clicktide_email_norm(p_email);
  v_reason text;
  v_since  timestamptz;
begin
  if p_user is null or v_email = '' then
    return false;
  end if;

  select s.reason, s.created_at
    into v_reason, v_since
    from public.email_suppressions s
   where s.user_id = p_user
     and s.email_lower = v_email
     for update;

  if found and v_reason is distinct from 'unsubscribe' then
    return false;
  end if;

  if exists (
    select 1 from public.customers c
     where c.user_id = p_user
       and public.clicktide_email_norm(c.email) = v_email
       and c.email_unsubscribed_at < coalesce(v_since, 'infinity'::timestamptz)
  ) then
    return false;
  end if;

  delete from public.email_suppressions s
   where s.user_id = p_user
     and s.email_lower = v_email
     and s.reason = 'unsubscribe';

  update public.customers c
     set email_unsubscribed_at = null
   where c.user_id = p_user
     and public.clicktide_email_norm(c.email) = v_email
     and c.email_unsubscribed_at >= v_since;

  return true;
end;
$$;

revoke all on function public.clicktide_email_resubscribe(uuid, text) from public, anon, authenticated;
grant execute on function public.clicktide_email_resubscribe(uuid, text) to service_role;

-- The C2 sender check in one call. Returns null when the business may email the
-- address; otherwise the suppression reason (never 'bounce' while a stronger block
-- exists), 'flagged' when any of that business's customer rows with this address has
-- email_unsubscribed_at set, or 'invalid' for an empty address.
create or replace function public.clicktide_email_send_block(
  p_user  uuid,
  p_email text
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email  text := public.clicktide_email_norm(p_email);
  v_reason text;
begin
  if p_user is null or v_email = '' then
    return 'invalid';
  end if;

  select coalesce(s.reason, 'unsubscribe')
    into v_reason
    from public.email_suppressions s
   where s.user_id = p_user
     and s.email_lower = v_email;

  if v_reason is not null and v_reason <> 'bounce' then
    return v_reason;
  end if;

  if exists (
    select 1 from public.customers c
     where c.user_id = p_user
       and public.clicktide_email_norm(c.email) = v_email
       and c.email_unsubscribed_at is not null
  ) then
    return 'flagged';
  end if;

  return v_reason;
end;
$$;

revoke all on function public.clicktide_email_send_block(uuid, text) from public, anon, authenticated;
grant execute on function public.clicktide_email_send_block(uuid, text) to service_role;
