-- WP1-billing 02 — subscription state written by stripe-webhook, read by create-checkout-session.
--
--   * clicktide_billing_apply_subscription(): the only writer of a business's Stripe billing
--     columns. It ignores an event older than the last one applied for that subscription, binds
--     by the verified user id first (never by email), does not let another subscription's event
--     overwrite a row that tracks a live one, and leaves `plan` empty unless the subscription is
--     active, trialing or past_due.
--   * stripe_trial_claims + clicktide_billing_checkout_context(): one free trial per account,
--     login email and Stripe customer.
--   * billing_checkout_sessions: subscription Checkout sessions created per account (so an older
--     open one can be expired, and every session can be traced back to the login that made it).
--   * billing_checkout_locks + clicktide_billing_checkout_lock/unlock(): one subscription checkout
--     start per account at a time.
--   * enforce_customer_cap(): once a business has subscribed, the cap follows the paid plan
--     while billing is in good standing, and never the browser-written selected_plan; before
--     that, selected_plan can raise the cap to at most 5,000 (never unlimited).
--
-- Idempotent and additive. The only data written is a one-time copy of existing subscription
-- ids into the new stripe_trial_claims table.

-- 1. stripe_webhook_events is written by the webhook only (RLS on, no policies; drop API grants).
revoke all on table public.stripe_webhook_events from anon, authenticated;

-- 2. Last applied Stripe event per subscription ----------------------------------------------

create table if not exists public.stripe_subscription_sync (
  subscription_id    text primary key,
  user_id            uuid,          -- set only from a verified checkout user id, never from a weak match
  customer_id        text,
  status             text,
  last_event_id      text,
  last_event_created timestamptz not null,
  updated_at         timestamptz not null default now()
);
create index if not exists stripe_subscription_sync_user_idx on public.stripe_subscription_sync (user_id);
alter table public.stripe_subscription_sync enable row level security;
revoke all on table public.stripe_subscription_sync from public, anon, authenticated;
grant select, insert, update on table public.stripe_subscription_sync to service_role;

-- 3. Trials already used -------------------------------------------------------------------------

create table if not exists public.stripe_trial_claims (
  subscription_id text primary key,
  user_id         uuid,
  email_lower     text,
  customer_id     text,
  source          text not null default 'webhook',
  created_at      timestamptz not null default now()
);
create index if not exists stripe_trial_claims_user_idx on public.stripe_trial_claims (user_id);
create index if not exists stripe_trial_claims_email_idx on public.stripe_trial_claims (email_lower);
create index if not exists stripe_trial_claims_customer_idx on public.stripe_trial_claims (customer_id);
alter table public.stripe_trial_claims enable row level security;
revoke all on table public.stripe_trial_claims from public, anon, authenticated;
grant select, insert, update on table public.stripe_trial_claims to service_role;

-- Every subscription so far came with the 30-day trial. Copying them here keeps that history even
-- if an owner deletes and re-creates their business row (the row's own columns would be gone).
insert into public.stripe_trial_claims (subscription_id, user_id, email_lower, customer_id, source)
select c.stripe_subscription_id,
       c.user_id,
       nullif(lower(btrim(coalesce(c.email, ''))), ''),
       c.stripe_customer_id,
       'backfill'
  from public.clicktide c
 where c.stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
on conflict (subscription_id) do nothing;

-- 4. Subscription Checkout sessions ----------------------------------------------------------

create table if not exists public.billing_checkout_sessions (
  session_id text primary key,
  user_id    uuid not null,
  mode       text not null,
  trial      boolean not null default false,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index if not exists billing_checkout_sessions_user_idx
  on public.billing_checkout_sessions (user_id, created_at desc);
alter table public.billing_checkout_sessions enable row level security;
revoke all on table public.billing_checkout_sessions from public, anon, authenticated;
grant select, insert, update on table public.billing_checkout_sessions to service_role;

-- One subscription checkout start per account at a time. A lease, not the fixed-window rate
-- limiter: two requests straddling a window boundary would both pass that.
create table if not exists public.billing_checkout_locks (
  user_id    uuid primary key,
  expires_at timestamptz not null
);
alter table public.billing_checkout_locks enable row level security;
revoke all on table public.billing_checkout_locks from public, anon, authenticated;
grant select, insert, update on table public.billing_checkout_locks to service_role;

create or replace function public.clicktide_billing_checkout_lock(p_user uuid, p_seconds integer default 15)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_got uuid;
begin
  if p_user is null or p_seconds is null or p_seconds <= 0 or p_seconds > 300 then
    return false;
  end if;
  insert into public.billing_checkout_locks as l (user_id, expires_at)
  values (p_user, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_seconds))
  on conflict (user_id) do update
     set expires_at = excluded.expires_at
   where l.expires_at <= pg_catalog.clock_timestamp()
  returning l.user_id into v_got;
  return v_got is not null;
end;
$$;

create or replace function public.clicktide_billing_checkout_unlock(p_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.billing_checkout_locks
     set expires_at = pg_catalog.clock_timestamp()
   where user_id = p_user;
$$;

-- 5. Apply a subscription's state ----------------------------------------------------------------

create or replace function public.clicktide_billing_apply_subscription(
  p_event_id text,
  p_event_created timestamptz,
  p_subscription_id text,
  p_customer_id text,
  p_user_id uuid,
  p_status text,
  p_price_id text,
  p_plan text,
  p_current_period_end timestamptz,
  p_trial_start timestamptz default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub        text := nullif(btrim(coalesce(p_subscription_id, '')), '');
  v_customer   text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_status     text := lower(nullif(btrim(coalesce(p_status, '')), ''));
  v_price      text := nullif(btrim(coalesce(p_price_id, '')), '');
  v_plan       text;
  v_known      boolean := coalesce(p_plan in ('Local', 'Growth', 'Scale'), false);
  v_last       timestamptz;
  v_match      text;
  v_found      integer := 0;
  v_rows       integer := 0;
  v_claim_user uuid := p_user_id;
  v_email      text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  if v_sub is null or v_sub !~ '^sub_[A-Za-z0-9]+$' or p_event_created is null or v_status is null
     or (v_customer is not null and v_customer !~ '^cus_[A-Za-z0-9]+$') then
    return jsonb_build_object('applied', false, 'reason', 'invalid_input');
  end if;

  -- No plan once the subscription stops paying (canceled, unpaid, paused, incomplete...).
  v_plan := case
              when v_status in ('active', 'trialing', 'past_due') and p_plan in ('Local', 'Growth', 'Scale') then p_plan
            end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('stripe_sub:' || v_sub));

  select s.last_event_created into v_last
    from public.stripe_subscription_sync s
   where s.subscription_id = v_sub;
  if v_last is not null and p_event_created < v_last then
    return jsonb_build_object('applied', false, 'reason', 'stale_event');
  end if;

  -- The verified user id (set by create-checkout-session from the caller's login) is the only
  -- way a subscription reaches a new business. Without one (subscriptions bought before that),
  -- only rows that already carry this subscription or customer id can be updated.
  -- A subscription on no Clicktide plan only updates the row that already tracks it.
  if not v_known then
    v_match := case
                 when exists (select 1 from public.clicktide c where c.stripe_subscription_id = v_sub)
                 then 'subscription_id' else 'none'
               end;
  elsif p_user_id is not null then
    v_match := 'user_id';
  elsif exists (select 1 from public.clicktide c where c.stripe_subscription_id = v_sub) then
    v_match := 'subscription_id';
  elsif v_customer is not null then
    v_match := 'customer_id';
  else
    v_match := 'none';
  end if;

  select count(*) into v_found
    from public.clicktide c
   where (v_match = 'user_id' and c.user_id = p_user_id)
      or (v_match = 'subscription_id' and c.stripe_subscription_id = v_sub)
      or (v_match = 'customer_id' and c.stripe_customer_id = v_customer);

  update public.clicktide c
     set plan                       = case
                                        when not v_known and v_status in ('active', 'trialing', 'past_due') then c.plan
                                        else v_plan
                                      end,
         stripe_customer_id         = coalesce(v_customer, c.stripe_customer_id),
         stripe_subscription_id     = v_sub,
         stripe_subscription_status = v_status,
         stripe_price_id            = v_price,
         stripe_current_period_end  = p_current_period_end
   where ((v_match = 'user_id' and c.user_id = p_user_id)
       or (v_match = 'subscription_id' and c.stripe_subscription_id = v_sub)
       or (v_match = 'customer_id' and c.stripe_customer_id = v_customer))
     -- A row that tracks a different subscription only moves to this one when that one has
     -- ended, or this one pays and that one doesn't, or this one is verified for the row's
     -- owner and that one never was. So a late event from an old subscription can't undo a newer one.
     and (c.stripe_subscription_id is null
       or c.stripe_subscription_id = v_sub
       or coalesce(lower(c.stripe_subscription_status), '') in ('', 'canceled', 'incomplete_expired')
       or (v_status in ('active', 'trialing')
           and (coalesce(lower(c.stripe_subscription_status), '') not in ('active', 'trialing')
                or (v_match = 'user_id' and not exists (
                      select 1 from public.stripe_subscription_sync s
                       where s.subscription_id = c.stripe_subscription_id
                         and s.user_id = c.user_id)))));
  get diagnostics v_rows = row_count;

  if p_trial_start is not null then
    if v_claim_user is null then
      select c.user_id into v_claim_user
        from public.clicktide c
       where c.stripe_subscription_id = v_sub
          or (v_customer is not null and c.stripe_customer_id = v_customer)
       order by c.id
       limit 1;
    end if;
    if v_email is null and v_claim_user is not null then
      select nullif(lower(btrim(coalesce(c.email, ''))), '') into v_email
        from public.clicktide c
       where c.user_id = v_claim_user
       order by c.id
       limit 1;
    end if;
    insert into public.stripe_trial_claims as t (subscription_id, user_id, email_lower, customer_id)
    values (v_sub, v_claim_user, v_email, v_customer)
    on conflict (subscription_id) do update
       set user_id     = coalesce(t.user_id, excluded.user_id),
           email_lower = coalesce(t.email_lower, excluded.email_lower),
           customer_id = coalesce(t.customer_id, excluded.customer_id);
  end if;

  if v_found = 0 then
    -- Not recorded as applied, so a retry can still land once the business row exists.
    return jsonb_build_object('applied', false, 'reason', 'no_row', 'match', v_match);
  end if;

  insert into public.stripe_subscription_sync as s
         (subscription_id, user_id, customer_id, status, last_event_id, last_event_created, updated_at)
  values (v_sub, p_user_id, v_customer, v_status, p_event_id, p_event_created, pg_catalog.now())
  on conflict (subscription_id) do update
     set user_id            = coalesce(s.user_id, excluded.user_id),
         customer_id        = coalesce(excluded.customer_id, s.customer_id),
         status             = excluded.status,
         last_event_id      = excluded.last_event_id,
         last_event_created = greatest(s.last_event_created, excluded.last_event_created),
         updated_at         = pg_catalog.now();

  return jsonb_build_object(
    'applied', v_rows > 0,
    'rows', v_rows,
    'match', v_match,
    'reason', case when v_rows > 0 then 'applied' else 'row_tracks_another_subscription' end,
    'status', v_status,
    'plan', v_plan
  );
end;
$$;

-- 6. What create-checkout-session needs to know --------------------------------------------------

create or replace function public.clicktide_billing_checkout_context(p_user uuid, p_email text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email    text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_customer text;
  v_sub      text;
  v_status   text;
  v_had      boolean;
begin
  if p_user is null then
    return jsonb_build_object('ok', false);
  end if;

  select c.stripe_customer_id, c.stripe_subscription_id, lower(c.stripe_subscription_status)
    into v_customer, v_sub, v_status
    from public.clicktide c
   where c.user_id = p_user
   order by (c.stripe_customer_id is not null) desc, c.id
   limit 1;

  v_had := v_sub is not null
    or v_status is not null
    or exists (select 1 from public.stripe_subscription_sync s where s.user_id = p_user)
    or exists (select 1
                 from public.stripe_trial_claims t
                where t.user_id = p_user
                   or (v_email is not null and t.email_lower = v_email)
                   or (v_customer is not null and t.customer_id = v_customer))
    or (v_email is not null and exists (
          select 1
            from public.clicktide c
           where lower(btrim(coalesce(c.email, ''))) = v_email
             and (c.stripe_subscription_id is not null or c.stripe_subscription_status is not null)));

  return jsonb_build_object(
    'ok', true,
    'customer_id', v_customer,
    'status', v_status,
    'trial_eligible', not v_had
  );
end;
$$;

-- 7. Customer cap ----------------------------------------------------------------------------------
-- Before: plan, else the browser-written selected_plan, whatever the billing status. A canceled
-- Scale business kept an unlimited cap. For a business that never subscribed, the plan picked in
-- onboarding (selected_plan, browser-written) still sizes the first POS import, which runs before
-- payment and is incremental afterwards, but it is never unlimited: picking Scale allows 5,000.

create or replace function public.enforce_customer_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p          text;
  v_picked   boolean := false;
  v_status   text;
  v_selected text;
  v_billed   boolean;
  cap        integer;
  n          integer;
begin
  if new.user_id is null then
    return new; -- legacy/demo rows
  end if;
  select lower(btrim(coalesce(c.plan, ''))),
         lower(btrim(coalesce(c.stripe_subscription_status, ''))),
         lower(btrim(coalesce(c.selected_plan, ''))),
         (c.stripe_subscription_id is not null or c.stripe_subscription_status is not null)
    into p, v_status, v_selected, v_billed
    from public.clicktide c
   where c.user_id = new.user_id
   order by (c.stripe_subscription_id is not null) desc, c.id
   limit 1;
  if coalesce(v_billed, false) then
    if v_status not in ('active', 'trialing', 'past_due') then
      p := '';
    end if;
  elsif coalesce(p, '') = '' then
    p := coalesce(v_selected, '');
    v_picked := true;
  end if;
  cap := case p
    when 'local' then 200
    when 'growth' then 1000
    when 'scale' then case when v_picked then 5000 end
    else 200
  end;
  if cap is not null then
    select count(*) into n from public.customers cu where cu.user_id = new.user_id;
    if n >= cap then
      raise exception 'PLAN_CUSTOMER_LIMIT_REACHED: your plan allows % customers. Upgrade to add more.', cap;
    end if;
  end if;
  return new;
end;
$$;

-- 8. Service role only -------------------------------------------------------------------------------

revoke all on function public.clicktide_billing_apply_subscription(text, timestamptz, text, text, uuid, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.clicktide_billing_apply_subscription(text, timestamptz, text, text, uuid, text, text, text, timestamptz, timestamptz, text) to service_role;

revoke all on function public.clicktide_billing_checkout_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.clicktide_billing_checkout_lock(uuid, integer) to service_role;

revoke all on function public.clicktide_billing_checkout_unlock(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_billing_checkout_unlock(uuid) to service_role;

revoke all on function public.clicktide_billing_checkout_context(uuid, text) from public, anon, authenticated;
grant execute on function public.clicktide_billing_checkout_context(uuid, text) to service_role;

revoke all on function public.enforce_customer_cap() from public, anon, authenticated;

notify pgrst, 'reload schema';
