-- Owner text alerts (Clicktide texting its own opted-in business owners).
-- 1) audit log of every owner text, 2) trigger that fires the registered opt-in
-- confirmation when an owner saves consent in Settings, 3) hourly results tick.

create table if not exists public.owner_sms_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null,               -- optin_confirm | results
  dedupe_key text not null,         -- "<phone>|<consent time>" or the owner-local date
  to_last4 text,
  body text,
  status text not null default 'sent',   -- sent | failed
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists owner_sms_log_lookup on public.owner_sms_log (user_id, kind, dedupe_key);
create index if not exists owner_sms_log_created on public.owner_sms_log (created_at desc);
alter table public.owner_sms_log enable row level security;
revoke all on public.owner_sms_log from anon, authenticated;
-- service role only (no policies)

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
      null; -- a settings save must never fail because of alert plumbing
    end;
  end if;
  return new;
end;
$$;
revoke all on function public.clicktide_owner_sms_optin_notify() from public, anon, authenticated;

drop trigger if exists clicktide_owner_sms_optin on public.clicktide;
create trigger clicktide_owner_sms_optin
  after insert or update of owner_sms_consent, owner_mobile on public.clicktide
  for each row execute function public.clicktide_owner_sms_optin_notify();

select cron.schedule(
  'clicktide-owner-alerts',
  '12 * * * *',
  $cron$
  select net.http_post(
    url := 'https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/owner-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-clicktide-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'CAMPAIGN_RUNNER_KEY')
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 60000
  )
  $cron$
);
