-- Applied to production as migration 20261126025302 (protect_billing_columns_normalize_pick).
-- Recovered verbatim from supabase_migrations.schema_migrations.statements on 2026-11-27,
-- so the repo records what the database already ran (branch claude/unruffled-aryabhata-b9b435).

-- Follow-up to protect_billing_columns: store selected_plan in one spelling for EVERY writer
-- (staff and the service role skip the rest of the guard, and the CHECK constraint is case-sensitive).
-- The repo file supabase/migrations/20261126030000_protect_billing_columns.sql already contains this version.
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
  -- selected_plan is stored in one spelling, whoever writes it ("growth" -> "Growth").
  if new.selected_plan is not null then
    v_pick := case lower(btrim(new.selected_plan))
                when 'local'  then 'Local'
                when 'growth' then 'Growth'
                when 'scale'  then 'Scale'
              end;
    if v_pick is not null then
      new.selected_plan := v_pick;
    end if;
    v_pick := null;
  end if;

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

revoke all on function public.clicktide_guard_protected_columns() from public, anon, authenticated;
