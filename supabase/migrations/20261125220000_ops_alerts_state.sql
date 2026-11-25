create table if not exists public.ops_alert_runs (
  id int primary key,
  last_run_at timestamptz not null default now()
);
create table if not exists public.ops_alert_status (
  user_id uuid primary key,
  last_status text,
  updated_at timestamptz not null default now()
);
alter table public.ops_alert_runs enable row level security;
alter table public.ops_alert_status enable row level security;
insert into public.ops_alert_runs (id, last_run_at) values (1, now()) on conflict (id) do nothing;
insert into public.ops_alert_status (user_id, last_status)
  select user_id, coalesce(stripe_subscription_status,'') from public.clicktide where user_id is not null
  on conflict (user_id) do nothing;
-- Hourly at :20 (pg_cron job 'clicktide-ops-alerts') → functions/v1/ops-alerts with x-clicktide-cron-key.
