-- WP5 / contract C5: run log + single-run leases for the background engines.
-- Idempotent and additive: safe to apply more than once. Apply BEFORE deploying the
-- campaign-runner / ai-suggest-campaigns / ops-alerts builds that use it.

-- 1. engine_runs: one row per engine run (written by the engines, read by ops-alerts).
create table if not exists public.engine_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  summary jsonb
);
create index if not exists engine_runs_job_started on public.engine_runs (job, started_at desc);
create index if not exists engine_runs_started on public.engine_runs (started_at);

alter table public.engine_runs enable row level security;
-- Service role only. No policies on purpose; TRUNCATE ignores RLS, so the grants go too.
revoke all on table public.engine_runs from public, anon, authenticated;
revoke all on sequence public.engine_runs_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.engine_runs to service_role;
grant usage, select on sequence public.engine_runs_id_seq to service_role;

-- 2. job_leases: at most one live holder per job.
create table if not exists public.job_leases (
  job text primary key,
  holder text not null,
  expires_at timestamptz not null
);
alter table public.job_leases enable row level security;
revoke all on table public.job_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.job_leases to service_role;

-- Take the lease for p_job for p_seconds. True when the caller now holds it: there was no
-- lease, the old one had expired, or the caller already held it (renewal). Atomic: the
-- single INSERT ... ON CONFLICT decides, so two callers can never both get true.
create or replace function public.clicktide_job_lease_acquire(p_job text, p_holder text, p_seconds integer)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_holder text;
begin
  if p_job is null or btrim(p_job) = '' or p_holder is null or btrim(p_holder) = ''
     or p_seconds is null or p_seconds <= 0 or p_seconds > 86400 then
    return false;
  end if;

  insert into public.job_leases as l (job, holder, expires_at)
  values (p_job, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (job) do update
     set holder = excluded.holder,
         expires_at = excluded.expires_at
   where l.expires_at <= now() or l.holder = excluded.holder
  returning l.holder into v_holder;

  return coalesce(v_holder = p_holder, false);
end;
$$;

-- Give the lease back; a no-op unless p_holder still holds it.
create or replace function public.clicktide_job_lease_release(p_job text, p_holder text)
returns void
language sql
volatile
set search_path = ''
as $$
  delete from public.job_leases where job = p_job and holder = p_holder;
$$;

revoke all on function public.clicktide_job_lease_acquire(text, text, integer) from public, anon, authenticated;
revoke all on function public.clicktide_job_lease_release(text, text) from public, anon, authenticated;
grant execute on function public.clicktide_job_lease_acquire(text, text, integer) to service_role;
grant execute on function public.clicktide_job_lease_release(text, text) to service_role;
