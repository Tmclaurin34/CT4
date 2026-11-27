-- Nightly Shopify job (06:40 UTC): retry unfinished compliance webhooks and re-read
-- each installed shop's App Pricing subscription. Off: select cron.unschedule('clicktide-shopify-nightly');
select cron.unschedule(jobid) from cron.job where jobname = 'clicktide-shopify-nightly';
select cron.schedule('clicktide-shopify-nightly', '40 6 * * *', $$
  select net.http_post(
    url := 'https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-clicktide-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'CAMPAIGN_RUNNER_KEY')),
    body := '{}'::jsonb)
$$);
