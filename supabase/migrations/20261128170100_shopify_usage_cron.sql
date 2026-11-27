-- Every 10 minutes: report Shopify usage (shopify-webhooks {"job":"usage"}): refresh stale usage
-- limits, finish Stripe->Shopify switches, net unsent refund pairs, send usage to Shopify, alert
-- on usage unreported for over an hour. Off: select cron.unschedule('clicktide-shopify-usage');
select cron.unschedule(jobid) from cron.job where jobname = 'clicktide-shopify-usage';
select cron.schedule('clicktide-shopify-usage', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://hmihfncvahsdlmefyxyg.supabase.co/functions/v1/shopify-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-clicktide-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'CAMPAIGN_RUNNER_KEY')),
    body := '{"job":"usage"}'::jsonb,
    timeout_milliseconds := 120000)
$$);
