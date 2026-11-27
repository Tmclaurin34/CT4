-- Nightly retention purge (04:10 UTC). Turn off: select cron.unschedule('clicktide-retention-purge');
select cron.unschedule(jobid) from cron.job where jobname = 'clicktide-retention-purge';
select cron.schedule('clicktide-retention-purge', '10 4 * * *', $$select public.clicktide_retention_purge(false)$$);
