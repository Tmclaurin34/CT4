-- Owner alerts now track the real delivery outcome (accepted -> delivered | failed)
-- so a text Twilio accepted but could not send is retried automatically.
alter table public.owner_sms_log add column if not exists error_code integer;
alter table public.owner_sms_log alter column status set default 'accepted';
update public.owner_sms_log set status = 'accepted' where status = 'sent';

-- Run every 10 minutes: reconcile delivery, retry confirmations, daily results text.
select cron.schedule(
  'clicktide-owner-alerts',
  '*/10 * * * *',
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
