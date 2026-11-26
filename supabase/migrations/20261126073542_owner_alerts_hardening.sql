-- Owner alerts hardening (findings of the pre-deploy review, 2026-11-26).

-- 1. One live row per text, and a destination fingerprint for per-number limits.
alter table public.owner_sms_log add column if not exists to_hash text;
create index if not exists owner_sms_log_to_hash on public.owner_sms_log (to_hash, created_at desc);
create unique index if not exists owner_sms_log_one_live
  on public.owner_sms_log (user_id, kind, dedupe_key)
  where status in ('sending', 'accepted', 'delivered');
alter table public.owner_sms_log alter column status set default 'sending';

-- 2. Atomic claim: a text is reserved in the log BEFORE Twilio is called, and the
--    limits are checked under a lock so overlapping calls cannot race past them.
create or replace function public.clicktide_owner_sms_claim(
  p_user_id uuid,
  p_kind text,
  p_dedupe_key text,
  p_to_hash text,
  p_to_last4 text,
  p_body text,
  p_user_daily_cap integer,
  p_dest_daily_cap integer,
  p_kind_daily_cap integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - interval '24 hours';
  v_live text[] := array['sending', 'accepted', 'delivered'];
  v_count integer;
  v_id bigint;
begin
  perform pg_advisory_xact_lock(727274, 1);

  if exists (
    select 1 from public.owner_sms_log
     where user_id = p_user_id and kind = p_kind and dedupe_key = p_dedupe_key and status = any (v_live)
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'duplicate');
  end if;

  -- Different texts of this kind the account started in the last day (retries of
  -- the same text do not count).
  select count(distinct dedupe_key) into v_count
    from public.owner_sms_log
   where user_id = p_user_id and kind = p_kind and created_at >= v_since and dedupe_key <> p_dedupe_key;
  if v_count >= p_user_daily_cap then
    return jsonb_build_object('claimed', false, 'reason', 'rate_limited_user');
  end if;

  -- Texts that went to this phone in the last day, across every account.
  select count(*) into v_count
    from public.owner_sms_log
   where to_hash = p_to_hash and created_at >= v_since and status = any (v_live);
  if v_count >= p_dest_daily_cap then
    return jsonb_build_object('claimed', false, 'reason', 'rate_limited_destination');
  end if;

  -- Platform-wide ceiling for this kind of text.
  select count(*) into v_count
    from public.owner_sms_log
   where kind = p_kind and created_at >= v_since and status = any (v_live);
  if v_count >= p_kind_daily_cap then
    return jsonb_build_object('claimed', false, 'reason', 'rate_limited_global');
  end if;

  insert into public.owner_sms_log (user_id, kind, dedupe_key, to_hash, to_last4, body, status)
  values (p_user_id, p_kind, p_dedupe_key, p_to_hash, p_to_last4, p_body, 'sending')
  returning id into v_id;

  return jsonb_build_object('claimed', true, 'id', v_id);
end;
$$;
revoke all on function public.clicktide_owner_sms_claim(uuid, text, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.clicktide_owner_sms_claim(uuid, text, text, text, text, text, integer, integer, integer) to service_role;

-- 3. The server owns the consent timestamp. The dashboard sends a new time on every
--    save; this keeps one timestamp per real opt-in, so "<phone>|<consent time>"
--    identifies a consent event and re-saving Settings can never re-text.
--    It also refuses to turn alerts on for a number that is not a US mobile shape.
create or replace function public.clicktide_owner_sms_consent_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new text := regexp_replace(coalesce(new.owner_mobile, ''), '\D', '', 'g');
  v_old text := '';
begin
  if tg_op = 'UPDATE' then
    v_old := regexp_replace(coalesce(old.owner_mobile, ''), '\D', '', 'g');
  end if;
  if length(v_new) = 11 and left(v_new, 1) = '1' then v_new := substr(v_new, 2); end if;
  if length(v_old) = 11 and left(v_old, 1) = '1' then v_old := substr(v_old, 2); end if;

  if new.owner_sms_consent is true then
    if v_new !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then
      raise exception 'Enter a valid US mobile number to turn on text alerts.' using errcode = '22023';
    end if;
    if tg_op = 'UPDATE' and old.owner_sms_consent is true and v_old = v_new and old.owner_sms_consent_at is not null then
      new.owner_sms_consent_at := old.owner_sms_consent_at;
    else
      new.owner_sms_consent_at := now();
    end if;
  else
    new.owner_sms_consent_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clicktide_owner_sms_consent_guard on public.clicktide;
create trigger clicktide_owner_sms_consent_guard
  before insert or update of owner_sms_consent, owner_mobile, owner_sms_consent_at on public.clicktide
  for each row execute function public.clicktide_owner_sms_consent_guard();

-- 4. The opt-in notifier now leaves a warning in the Postgres log if it cannot queue
--    the call, instead of failing silently. (The tick retries it within 10 minutes.)
create or replace function public.clicktide_owner_sms_optin_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_sms_consent is true
     and coalesce(new.owner_mobile, '') <> ''
     and new.user_id is not null
     and (tg_op = 'INSERT'
          or old.owner_sms_consent is distinct from true
          or coalesce(old.owner_mobile, '') is distinct from coalesce(new.owner_mobile, '')) then
    begin
      perform net.http_post(
        url := 'https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/owner-alerts',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-clicktide-cron-key', public.clicktide_internal_key()
        ),
        body := jsonb_build_object('action', 'optin_confirm', 'user_id', new.user_id),
        timeout_milliseconds := 20000
      );
    exception when others then
      raise warning 'owner sms opt-in notify failed: %', sqlerrm; -- never block the save
    end;
  end if;
  return new;
end;
$$;
revoke all on function public.clicktide_owner_sms_optin_notify() from public, anon, authenticated;

-- 5. A Messaging Service can be active on only one registration. Clicktide's own
--    service (the reg_type='platform' row) can therefore never also be activated
--    on a business's row by mistake.
create unique index if not exists a2p_registrations_active_msid_uniq
  on public.a2p_registrations (messaging_service_sid)
  where sms_status = 'active' and messaging_service_sid is not null;
