-- Applied to production as migration 20261126024849 (protect_billing_columns).
-- Recovered verbatim from supabase_migrations.schema_migrations.statements on 2026-11-27,
-- so the repo records what the database already ran (branch claude/unruffled-aryabhata-b9b435).

-- =====================================================================
-- Protect plan / billing / wallet / identity from the browser (2026-11-25)
--
-- THE HOLE (reproduced on the live project with a real signed-in owner token)
--   public.clicktide is owner-writable through RLS: clicktide_user_all allows
--   it, and clicktide_staff_client_access ALSO passes for the owner because
--   clicktide_can_access_client() starts with "auth.uid() = client_id". Every
--   column was writable and nothing guarded the billing ones, so any owner
--   could run this from the browser console:
--     PATCH /rest/v1/clicktide {"plan":"Scale","stripe_subscription_status":"active"}
--       -> free top-tier plan + paid access (campaign sending, gifts, texts)
--     POST  /rest/v1/wallet    {"amount":99999,"balance":99999, ...}
--       -> free gift-wallet money. public.wallet is the REAL wallet: the newest
--          row's `balance` is what gift / postcard fulfilment debits against.
--          (clicktide.wallet_balance is a legacy column nothing reads.)
--
-- THE FIX
--   1. public.clicktide gets a BEFORE INSERT/UPDATE guard. Unless the writer is
--        * the service role  (edge functions: stripe-webhook, create-checkout-session, ...)
--        * a direct database login (SQL editor, migrations, pg_cron), or
--        * Clicktide admin / support staff (back office),
--      these columns keep their stored value whatever the request says:
--        plan, stripe_subscription_status, stripe_customer_id,
--        stripe_subscription_id, stripe_price_id, stripe_current_period_end,
--        wallet_balance, user_id, email
--      The request is NOT rejected: the live site still sends `plan` along with
--      a few onboarding saves, and those saves must keep working. The protected
--      values are simply left as they were.
--   2. New column clicktide.selected_plan = the plan the owner PICKED during
--      onboarding. It is a preference, never an entitlement. `plan` is now only
--      ever what Stripe says (stripe-webhook derives it from the Stripe price
--      once checkout completes). A `plan` sent by an older browser build is
--      filed under selected_plan instead.
--   3. public.wallet: owners (and partners) can read the ledger but can no
--      longer write it. Only the service role and admin / support staff add rows.
--
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. selected_plan: what the owner picked (not what they pay for)
-- ---------------------------------------------------------------------
alter table public.clicktide add column if not exists selected_plan text;

comment on column public.clicktide.selected_plan is
  'Plan the owner picked during onboarding (Local / Growth / Scale). A preference only - never used to unlock paid features. The paid plan lives in "plan" and is written only by stripe-webhook.';
comment on column public.clicktide.plan is
  'Paid plan, derived from the Stripe price by stripe-webhook. Not writable from the browser (see clicktide_guard_protected_columns). NULL until a subscription exists.';
comment on column public.clicktide.wallet_balance is
  'LEGACY - not used. The gift wallet is the public.wallet ledger (see clicktide_wallet_balance()).';

-- Keep what people already picked ...
update public.clicktide
   set selected_plan = case lower(btrim(plan))
                         when 'local'  then 'Local'
                         when 'growth' then 'Growth'
                         when 'scale'  then 'Scale'
                       end
 where selected_plan is null
   and plan is not null;

-- ... and stop treating a pick as a plan. A business that has never had a
-- subscription only ever had `plan` because the browser typed it in.
update public.clicktide
   set plan = null
 where plan is not null
   and stripe_subscription_id is null
   and stripe_subscription_status is null
   and stripe_customer_id is null;

alter table public.clicktide drop constraint if exists clicktide_selected_plan_check;
alter table public.clicktide add constraint clicktide_selected_plan_check
  check (selected_plan is null or selected_plan in ('Local', 'Growth', 'Scale'));

-- ---------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------
create or replace function public.clicktide_guard_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Who is writing? PostgREST puts the verified JWT here for every API request.
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
  v_pick    text;
  v_ignored text[] := array[]::text[];
begin
  -- Trusted writers pass straight through.
  if v_role = 'service_role' then
    return new;                                   -- edge functions / webhooks
  end if;
  if v_role is null and session_user <> 'authenticator' then
    return new;                                   -- SQL editor, migrations, pg_cron (not the REST API)
  end if;
  if v_role = 'authenticated' and public.clicktide_is_staff(array['admin', 'support']) then
    return new;                                   -- Clicktide staff in the back office
  end if;

  -- Everyone else: business owners (and partners) in the browser.
  if tg_op = 'INSERT' then
    -- The plan they picked: an explicit selected_plan, else the legacy `plan` field.
    v_pick := case lower(btrim(coalesce(nullif(btrim(new.selected_plan), ''), new.plan, '')))
                when 'local'  then 'Local'
                when 'growth' then 'Growth'
                when 'scale'  then 'Scale'
              end;

    if new.stripe_subscription_status is not null then v_ignored := array_append(v_ignored, 'stripe_subscription_status'); end if;
    if new.stripe_customer_id         is not null then v_ignored := array_append(v_ignored, 'stripe_customer_id'); end if;
    if new.stripe_subscription_id     is not null then v_ignored := array_append(v_ignored, 'stripe_subscription_id'); end if;
    if new.stripe_price_id            is not null then v_ignored := array_append(v_ignored, 'stripe_price_id'); end if;
    if new.stripe_current_period_end  is not null then v_ignored := array_append(v_ignored, 'stripe_current_period_end'); end if;
    if coalesce(new.wallet_balance, 0) <> 0       then v_ignored := array_append(v_ignored, 'wallet_balance'); end if;

    -- A brand-new business has no plan, no billing and an empty wallet ...
    new.selected_plan              := v_pick;
    new.plan                       := null;
    new.stripe_subscription_status := null;
    new.stripe_customer_id         := null;
    new.stripe_subscription_id     := null;
    new.stripe_price_id            := null;
    new.stripe_current_period_end  := null;
    new.wallet_balance             := 0;
    -- ... and carries its owner's real login email. stripe-webhook falls back to
    -- matching on this column, so it must not be a value the browser chose.
    -- (user_id itself is pinned to the signed-in user by the RLS WITH CHECK.)
    new.email := (select u.email::text from auth.users u where u.id = new.user_id);

  else  -- UPDATE
    if new.plan is distinct from old.plan
       and new.selected_plan is not distinct from old.selected_plan then
      -- An older browser build still sends `plan` with a few onboarding saves.
      -- Keep it as the owner's pick, never as the entitlement.
      v_pick := case lower(btrim(coalesce(new.plan, '')))
                  when 'local'  then 'Local'
                  when 'growth' then 'Growth'
                  when 'scale'  then 'Scale'
                end;
      if v_pick is not null then
        new.selected_plan := v_pick;
      end if;
    elsif new.selected_plan is distinct from old.selected_plan then
      v_pick := case lower(btrim(coalesce(new.selected_plan, '')))
                  when 'local'  then 'Local'
                  when 'growth' then 'Growth'
                  when 'scale'  then 'Scale'
                end;
      new.selected_plan := coalesce(v_pick, old.selected_plan);
    end if;

    -- Worth a log line: nothing legitimate in the browser changes these.
    -- (`plan` only counts once a subscription exists - before that the live
    -- site sends it during onboarding.)
    if new.plan is distinct from old.plan
       and (old.stripe_subscription_id is not null or old.stripe_subscription_status is not null) then
      v_ignored := array_append(v_ignored, 'plan');
    end if;
    if new.stripe_subscription_status is distinct from old.stripe_subscription_status then v_ignored := array_append(v_ignored, 'stripe_subscription_status'); end if;
    if new.stripe_customer_id         is distinct from old.stripe_customer_id         then v_ignored := array_append(v_ignored, 'stripe_customer_id'); end if;
    if new.stripe_subscription_id     is distinct from old.stripe_subscription_id     then v_ignored := array_append(v_ignored, 'stripe_subscription_id'); end if;
    if new.stripe_price_id            is distinct from old.stripe_price_id            then v_ignored := array_append(v_ignored, 'stripe_price_id'); end if;
    if new.stripe_current_period_end  is distinct from old.stripe_current_period_end  then v_ignored := array_append(v_ignored, 'stripe_current_period_end'); end if;
    if new.wallet_balance             is distinct from old.wallet_balance             then v_ignored := array_append(v_ignored, 'wallet_balance'); end if;
    if new.user_id                    is distinct from old.user_id                    then v_ignored := array_append(v_ignored, 'user_id'); end if;
    if new.email                      is distinct from old.email                      then v_ignored := array_append(v_ignored, 'email'); end if;

    -- Keep the stored values, whatever the request said.
    new.plan                       := old.plan;
    new.stripe_subscription_status := old.stripe_subscription_status;
    new.stripe_customer_id         := old.stripe_customer_id;
    new.stripe_subscription_id     := old.stripe_subscription_id;
    new.stripe_price_id            := old.stripe_price_id;
    new.stripe_current_period_end  := old.stripe_current_period_end;
    new.wallet_balance             := old.wallet_balance;
    new.user_id                    := old.user_id;
    new.email                      := old.email;
  end if;

  if array_length(v_ignored, 1) > 0 then
    raise log 'clicktide_guard: ignored browser write to protected column(s) [%] on business % by auth user %',
      array_to_string(v_ignored, ', '), coalesce(new.user_id::text, '?'), coalesce(v_claims ->> 'sub', '?');
  end if;

  return new;
end;
$$;

comment on function public.clicktide_guard_protected_columns() is
  'BEFORE INSERT/UPDATE guard on public.clicktide: plan, stripe_*, wallet_balance, user_id and email cannot be changed from the browser. Service role, direct DB logins and admin/support staff are exempt.';

revoke all on function public.clicktide_guard_protected_columns() from public, anon, authenticated;

drop trigger if exists clicktide_guard_protected_columns on public.clicktide;
create trigger clicktide_guard_protected_columns
  before insert or update on public.clicktide
  for each row execute function public.clicktide_guard_protected_columns();

-- ---------------------------------------------------------------------
-- 3. Customer cap: paid plan when there is one, otherwise the plan picked at
--    sign-up - so a new business can still load its customer list for the
--    Drift Reveal before checkout, exactly as before.
-- ---------------------------------------------------------------------
create or replace function public.enforce_customer_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p text;
  cap integer;
  n integer;
begin
  if new.user_id is null then
    return new; -- legacy/demo rows
  end if;
  select lower(coalesce(nullif(btrim(c.plan), ''), c.selected_plan, ''))
    into p
    from public.clicktide c
   where c.user_id = new.user_id
   limit 1;
  cap := case p
    when 'local' then 200
    when 'growth' then 1000
    when 'scale' then null
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

revoke all on function public.enforce_customer_cap() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Gift wallet ledger: read-only for the business
--    Before: wallet_user_all (ALL) + wallet_staff_client_access (ALL, which the
--    owner also satisfied) let an owner insert / edit / delete ledger rows.
--    Now: the owner and their partner can read; admin / support staff can add
--    rows (the back-office refund button); nobody edits or deletes through the
--    API. Edge functions use the service role, which bypasses RLS.
-- ---------------------------------------------------------------------
drop policy if exists wallet_user_all on public.wallet;
drop policy if exists wallet_staff_client_access on public.wallet;
drop policy if exists wallet_owner_read on public.wallet;
drop policy if exists wallet_staff_read on public.wallet;
drop policy if exists wallet_staff_insert on public.wallet;

create policy wallet_owner_read on public.wallet
  for select to authenticated
  using (auth.uid() = user_id);

create policy wallet_staff_read on public.wallet
  for select to authenticated
  using (public.clicktide_can_access_client(user_id));

create policy wallet_staff_insert on public.wallet
  for insert to authenticated
  with check (public.clicktide_is_staff(array['admin', 'support']));

revoke update, delete, truncate on table public.wallet from anon, authenticated;
revoke insert on table public.wallet from anon;
