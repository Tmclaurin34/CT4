-- 1. Shared rate limiter for public / cost-bearing endpoints (service role only).
--    Fixed windows; one atomic upsert per hit, so concurrent requests can't race it.
create table if not exists public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
create index if not exists rate_limits_window_start on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.clicktide_rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_hits integer;
begin
  if p_bucket is null or p_window_seconds is null or p_max is null or p_window_seconds <= 0 or p_max <= 0 then
    return false;
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (left(p_bucket, 200), v_start, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  return v_hits <= p_max;
end;
$$;
revoke all on function public.clicktide_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.clicktide_rate_limit_hit(text, integer, integer) to service_role;

select cron.schedule(
  'clicktide-rate-limit-cleanup',
  '17 3 * * *',
  $cron$ delete from public.rate_limits where window_start < now() - interval '2 days' $cron$
);

-- 2. Separate consent for account & service texts (visit reminders, gift/order updates),
--    so a customer who only ticked that box never receives marketing texts.
alter table public.customers
  add column if not exists sms_service_consent boolean not null default false,
  add column if not exists sms_service_consent_at timestamptz;
