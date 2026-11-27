-- Nightly schedule for public.clicktide_security_retention_purge() (see 01_security_retention_purge.sql).
-- Repo file: supabase/migrations/20261128130100_security_retention_cron.sql
-- 09:25 UTC = 4:25am EST / 5:25am EDT in New York (1:25am PST / 2:25am PDT in Los Angeles):
-- no customer traffic, and it avoids the :00/:10/:20/:30/:40/:50 slots used by campaign-runner,
-- owner-alerts, ops-alerts and platform-sync, plus 03:17 (rate-limit cleanup), 04:10
-- (clicktide-retention-purge) and 06:30/06:40 (rhythm, Shopify).
-- The command passes false EXPLICITLY: the function treats a missing or NULL argument as a dry run.
-- pg_cron 1.6 cron.schedule(name, ...) updates the job in place when the name already
-- exists, so re-running this file is safe.
select cron.schedule(
  'clicktide-security-retention',
  '25 9 * * *',
  'select public.clicktide_security_retention_purge(false)'
);
