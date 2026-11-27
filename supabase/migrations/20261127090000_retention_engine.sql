-- Clicktide retention engine — phases 1–2 (2026-11-27). ADDITIVE ONLY.
--
-- Phase 1  Visit history
--   customer_visits         one row per genuine visit (a customer's transactions on the same
--                           business-local day are one visit; optional merge window in hours)
--   pos_transactions_seen   idempotency ledger: a POS transaction id is only ever counted once
--   clicktide_record_visit  the ONE writer for both (service role only)
--
-- Phase 2  One rhythm engine, SHADOW MODE
--   retention_category_priors  editable starting estimates per business type (data overrides)
--   clicktide_rhythm_core      pure per-customer evaluation (median gaps, breaks, variability,
--                              confidence, thresholds, status) — unit-tested
--   clicktide_refresh_rhythm   evaluates one business, writes customer_rhythm + status events
--   customer_rhythm            latest evaluation per customer (+ legacy flag for comparison)
--   customer_status_events     every status change (drifting / at_risk / recovered …)
--
-- Nothing here changes existing columns, campaign sends, billing or customer records.
-- Existing readers (dashboard, campaign-runner, reports) are untouched until phase 3.

-- ---------------------------------------------------------------------------
-- Business settings + helpers
-- ---------------------------------------------------------------------------
alter table public.clicktide
  add column if not exists visit_merge_hours int not null default 0
  check (visit_merge_hours between 0 and 24);
comment on column public.clicktide.visit_merge_hours is
  'Retention engine: transactions on the same local day are one visit; additionally merge into the previous visit when within this many hours (0 = off).';

create or replace function public.clicktide_state_tz(p_state text)
returns text language sql immutable set search_path to 'public' as $$
  select case upper(btrim(coalesce(p_state,'')))
    when 'CA' then 'America/Los_Angeles' when 'WA' then 'America/Los_Angeles' when 'OR' then 'America/Los_Angeles' when 'NV' then 'America/Los_Angeles'
    when 'AZ' then 'America/Phoenix'
    when 'CO' then 'America/Denver' when 'UT' then 'America/Denver' when 'NM' then 'America/Denver' when 'MT' then 'America/Denver' when 'WY' then 'America/Denver' when 'ID' then 'America/Denver'
    when 'TX' then 'America/Chicago' when 'IL' then 'America/Chicago' when 'MN' then 'America/Chicago' when 'WI' then 'America/Chicago' when 'MO' then 'America/Chicago'
    when 'IA' then 'America/Chicago' when 'KS' then 'America/Chicago' when 'NE' then 'America/Chicago' when 'OK' then 'America/Chicago' when 'AR' then 'America/Chicago'
    when 'LA' then 'America/Chicago' when 'MS' then 'America/Chicago' when 'AL' then 'America/Chicago' when 'TN' then 'America/Chicago' when 'ND' then 'America/Chicago' when 'SD' then 'America/Chicago'
    when 'AK' then 'America/Anchorage' when 'HI' then 'Pacific/Honolulu'
    else 'America/New_York' end
$$;

create or replace function public.clicktide_category_of(p_business_type text)
returns text language sql immutable set search_path to 'public' as $$
  select case
    when p_business_type is null or btrim(p_business_type) = '' then 'other'
    when p_business_type ~* 'barber' then 'barber'
    when p_business_type ~* 'nail' then 'nails'
    when p_business_type ~* 'salon|hair|beauty|lash|brow' then 'salon'
    when p_business_type ~* 'spa|massage|wellness' then 'spa'
    when p_business_type ~* 'pet|groom|dog|vet' then 'pet_grooming'
    when p_business_type ~* 'yoga|pilates|studio|barre|dance|martial' then 'studio'
    when p_business_type ~* 'gym|fitness|crossfit|boxing|training' then 'gym'
    when p_business_type ~* 'cafe|café|coffee|bakery|tea|juice|smoothie' then 'cafe'
    when p_business_type ~* 'restaurant|food|pizza|bar|grill|diner|eatery' then 'restaurant'
    when p_business_type ~* 'retail|shop|store|boutique|apparel|gift' then 'retail'
    else 'other' end
$$;

-- Starting estimates only. A business's own customers replace these as soon as
-- at least 5 of them have a learned rhythm; each customer's own history wins over both.
create table if not exists public.retention_category_priors (
  category text primary key,
  typical_interval_days numeric not null check (typical_interval_days > 0),
  note text
);
insert into public.retention_category_priors (category, typical_interval_days, note) values
  ('barber', 28, 'starting estimate'), ('salon', 35, 'starting estimate'), ('nails', 21, 'starting estimate'),
  ('spa', 42, 'starting estimate'), ('pet_grooming', 49, 'starting estimate'), ('studio', 7, 'starting estimate'),
  ('gym', 7, 'starting estimate'), ('cafe', 10, 'starting estimate'), ('restaurant', 21, 'starting estimate'),
  ('retail', 45, 'starting estimate'), ('other', 30, 'starting estimate')
on conflict (category) do nothing;
alter table public.retention_category_priors enable row level security;
drop policy if exists retention_priors_read on public.retention_category_priors;
create policy retention_priors_read on public.retention_category_priors for select to authenticated using (true);
grant select on public.retention_category_priors to authenticated;

-- ---------------------------------------------------------------------------
-- Phase 1 tables
-- ---------------------------------------------------------------------------
create table if not exists public.customer_visits (
  id           bigserial primary key,
  user_id      uuid not null,
  customer_id  bigint not null references public.customers(id) on delete cascade,
  visited_on   date not null,                -- business-local date
  first_at     timestamptz not null,
  last_at      timestamptz not null,
  txn_count    int not null default 1 check (txn_count >= 1),
  amount       numeric not null default 0,
  sources      text[] not null default '{}',
  created_at   timestamptz not null default now(),
  unique (customer_id, visited_on)
);
create index if not exists customer_visits_user_idx on public.customer_visits(user_id, customer_id, visited_on);
alter table public.customer_visits enable row level security;
drop policy if exists customer_visits_owner_select on public.customer_visits;
create policy customer_visits_owner_select on public.customer_visits for select to authenticated
  using (auth.uid() = user_id or public.clicktide_can_access_client(user_id));
revoke insert, update, delete on public.customer_visits from anon, authenticated;
grant select on public.customer_visits to authenticated;

create table if not exists public.pos_transactions_seen (
  user_id        uuid not null,
  source         text not null,
  source_txn_id  text not null,
  customer_id    bigint references public.customers(id) on delete cascade,
  occurred_at    timestamptz,
  amount         numeric,
  seen_at        timestamptz not null default now(),
  primary key (user_id, source, source_txn_id)
);
alter table public.pos_transactions_seen enable row level security;   -- service role only
revoke all on public.pos_transactions_seen from anon, authenticated;

-- The one writer. Returns 'duplicate' | 'new_visit' | 'same_visit'.
create or replace function public.clicktide_record_visit(
  p_user uuid, p_customer bigint, p_at timestamptz, p_amount numeric,
  p_source text, p_txn_id text default null)
returns text language plpgsql security definer set search_path to 'public' as $$
declare
  v_tz text; v_merge int; v_day date; v_prev record; v_new boolean;
begin
  if p_user is null or p_customer is null or p_at is null then return 'invalid'; end if;
  if p_txn_id is not null and btrim(p_txn_id) <> '' then
    insert into pos_transactions_seen(user_id, source, source_txn_id, customer_id, occurred_at, amount)
    values (p_user, coalesce(p_source,'unknown'), p_txn_id, p_customer, p_at, p_amount)
    on conflict do nothing;
    if not found then return 'duplicate'; end if;
  end if;

  select clicktide_state_tz(c.state), coalesce(c.visit_merge_hours,0) into v_tz, v_merge
    from clicktide c where c.user_id = p_user limit 1;
  v_tz := coalesce(v_tz, 'America/New_York');
  v_day := (p_at at time zone v_tz)::date;

  if coalesce(v_merge,0) > 0 then
    select * into v_prev from customer_visits
     where customer_id = p_customer and last_at <= p_at and p_at - last_at <= make_interval(hours => v_merge)
     order by last_at desc limit 1;
    if found then
      update customer_visits set txn_count = txn_count + 1, amount = amount + greatest(coalesce(p_amount,0),0),
             last_at = greatest(last_at, p_at),
             sources = (select array_agg(distinct s) from unnest(sources || coalesce(p_source,'unknown')) s)
       where id = v_prev.id;
      return 'same_visit';
    end if;
  end if;

  insert into customer_visits(user_id, customer_id, visited_on, first_at, last_at, txn_count, amount, sources)
  values (p_user, p_customer, v_day, p_at, p_at, 1, greatest(coalesce(p_amount,0),0), array[coalesce(p_source,'unknown')])
  on conflict (customer_id, visited_on) do update
     set txn_count = customer_visits.txn_count + 1,
         amount    = customer_visits.amount + excluded.amount,
         first_at  = least(customer_visits.first_at, excluded.first_at),
         last_at   = greatest(customer_visits.last_at, excluded.last_at),
         sources   = (select array_agg(distinct s) from unnest(customer_visits.sources || excluded.sources) s)
  returning (xmax = 0) into v_new;
  return case when v_new then 'new_visit' else 'same_visit' end;
end;
$$;
revoke all on function public.clicktide_record_visit(uuid,bigint,timestamptz,numeric,text,text) from public, anon, authenticated;
grant execute on function public.clicktide_record_visit(uuid,bigint,timestamptz,numeric,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- Phase 2 tables
-- ---------------------------------------------------------------------------
create table if not exists public.customer_rhythm (
  customer_id        bigint primary key references public.customers(id) on delete cascade,
  user_id            uuid not null,
  computed_at        timestamptz not null default now(),
  data_basis         text not null,          -- visit_history | summary_only | none
  visits_observed    int not null default 0,
  gaps_used          int not null default 0,
  breaks_excluded    int not null default 0,
  expected_interval  numeric,                -- days
  interval_source    text,                   -- observed | blended | summary_average | business | category | default
  variability        numeric,                -- robust spread of gaps ÷ median (lower = steadier)
  confidence         text not null,          -- insufficient | low | medium | high
  last_visit_on      date,
  days_since         int,
  overdue_ratio      numeric,
  drift_after_days   numeric,
  at_risk_after_days numeric,
  status             text not null,          -- healthy | drifting | at_risk | recovered | no_history
  status_since       timestamptz not null default now(),
  seasonal_hint      boolean not null default false,
  reason             text not null default '',
  legacy_drifting    boolean                 -- what the current dashboard rule says (shadow comparison)
);
create index if not exists customer_rhythm_user_idx on public.customer_rhythm(user_id, status);
alter table public.customer_rhythm enable row level security;
drop policy if exists customer_rhythm_owner_select on public.customer_rhythm;
create policy customer_rhythm_owner_select on public.customer_rhythm for select to authenticated
  using (auth.uid() = user_id or public.clicktide_can_access_client(user_id));
revoke insert, update, delete on public.customer_rhythm from anon, authenticated;
grant select on public.customer_rhythm to authenticated;

create table if not exists public.customer_status_events (
  id                bigserial primary key,
  user_id           uuid not null,
  customer_id       bigint not null references public.customers(id) on delete cascade,
  from_status       text,
  to_status         text not null,
  occurred_at       timestamptz not null default now(),
  days_since        int,
  expected_interval numeric,
  overdue_ratio     numeric,
  reason            text
);
create index if not exists customer_status_events_idx on public.customer_status_events(user_id, occurred_at desc);
create index if not exists customer_status_events_cust_idx on public.customer_status_events(customer_id, occurred_at desc);
alter table public.customer_status_events enable row level security;
drop policy if exists customer_status_events_owner_select on public.customer_status_events;
create policy customer_status_events_owner_select on public.customer_status_events for select to authenticated
  using (auth.uid() = user_id or public.clicktide_can_access_client(user_id));
revoke insert, update, delete on public.customer_status_events from anon, authenticated;
grant select on public.customer_status_events to authenticated;

-- ---------------------------------------------------------------------------
-- Phase 2 engine: pure per-customer evaluation
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_median(p numeric[])
returns numeric language sql immutable set search_path to 'public' as $$
  select percentile_cont(0.5) within group (order by x)::numeric from unnest(p) x
$$;

create or replace function public.clicktide_rhythm_core(
  p_days        date[],     -- this customer's visit dates (business-local, any order; duplicates ignored)
  p_sum_visits  int,        -- summary counters, used only when no visit history exists
  p_sum_first   date,
  p_sum_last    date,
  p_base        numeric,    -- fallback interval for this business (days)
  p_base_source text,       -- business | category | default
  p_today       date)
returns table (
  data_basis text, visits_observed int, gaps_used int, breaks_excluded int,
  expected_interval numeric, interval_source text, variability numeric, confidence text,
  last_visit_on date, days_since int, overdue_ratio numeric,
  drift_after_days numeric, at_risk_after_days numeric, base_status text, seasonal_hint boolean)
language plpgsql immutable set search_path to 'public' as $$
declare
  d date[]; n int; g int := 0; gaps numeric[] := '{}'; used numeric[] := '{}';
  m numeric; m2 numeric; mad numeric; v numeric; own numeric; tol numeric;
  i int; nbreak int := 0; span int; base numeric := greatest(coalesce(p_base, 30), 1);
begin
  select array_agg(x order by x) into d from (select distinct x from unnest(p_days) x where x is not null and x <= p_today) t;
  n := coalesce(array_length(d,1), 0);

  if n >= 1 then
    data_basis := 'visit_history';
    visits_observed := n;
    last_visit_on := d[n];
    for i in 2..n loop gaps := gaps || (d[i] - d[i-1])::numeric; end loop;
    g := coalesce(array_length(gaps,1),0);
    if g >= 1 then
      m := clicktide_median(gaps);
      -- A gap far beyond the customer's norm (holiday, illness, off-season) is a break,
      -- not their rhythm: excluded once there's enough history to tell the difference.
      if g >= 4 then
        select array_agg(x) into used from unnest(gaps) x where not (x > 4*m and x >= m + 14);
        nbreak := g - coalesce(array_length(used,1),0);
      else
        used := gaps;
      end if;
      m2 := clicktide_median(used);
      select clicktide_median(array_agg(abs(x - m2))) into mad from unnest(used) x;
      v := case when m2 > 0 then round((1.4826 * mad / m2)::numeric, 3) end;
      own := greatest(m2, 1);
      gaps_used := coalesce(array_length(used,1),0);
    end if;
    span := d[n] - d[1];
    seasonal_hint := (span >= 330 and nbreak >= 1);
  elsif p_sum_last is not null then
    data_basis := 'summary_only';
    visits_observed := greatest(coalesce(p_sum_visits,1),1);
    last_visit_on := least(p_sum_last, p_today);
    if visits_observed >= 2 and p_sum_first is not null and p_sum_last > p_sum_first then
      own := greatest(((p_sum_last - p_sum_first)::numeric / (visits_observed - 1)), 1);
      g := visits_observed - 1;
    end if;
    seasonal_hint := false;
  else
    data_basis := 'none';
    visits_observed := 0;
    seasonal_hint := false;
  end if;
  breaks_excluded := nbreak;
  gaps_used := coalesce(gaps_used, case when data_basis = 'summary_only' then g else 0 end);
  variability := v;

  -- Expected interval: own history when there's enough of it; a log-space blend with the
  -- business rhythm for 1–2 gaps; the business/category rhythm when there's no gap yet.
  if own is not null and data_basis = 'visit_history' and gaps_used >= 3 then
    expected_interval := round(own, 1); interval_source := 'observed';
  elsif own is not null and data_basis = 'summary_only' and g >= 3 then
    expected_interval := round(own, 1); interval_source := 'summary_average';
  elsif own is not null then
    expected_interval := round(exp((least(g,2) * ln(own) + 2 * ln(base)) / (least(g,2) + 2)), 1);
    interval_source := 'blended';
  else
    expected_interval := round(base, 1); interval_source := coalesce(p_base_source, 'default');
  end if;

  confidence := case
    when visits_observed <= 1 then 'insufficient'
    when data_basis = 'summary_only' then 'low'
    when gaps_used <= 2 then 'low'
    when gaps_used <= 6 then case when coalesce(v,0) > 1.0 then 'low' else 'medium' end
    when coalesce(v,0) <= 0.6 then 'high'
    when coalesce(v,0) <= 1.2 then 'medium'
    else 'low' end;

  -- How far past their norm counts as drifting depends on how steady they are:
  -- a very regular customer is flagged sooner than an irregular one. Less certain
  -- estimates get a wider window so a thin history never looks falsely precise.
  tol := greatest(0.5, 2 * coalesce(v, 0.25));
  if confidence in ('insufficient','low') then tol := greatest(tol, 0.75); end if;
  drift_after_days := round(greatest(expected_interval * (1 + tol), expected_interval + 3), 1);
  at_risk_after_days := round(greatest(drift_after_days + expected_interval, drift_after_days * 1.6, drift_after_days + 7), 1);

  if last_visit_on is null then
    days_since := null; overdue_ratio := null; base_status := 'no_history';
  else
    days_since := p_today - last_visit_on;
    overdue_ratio := round(days_since / expected_interval, 2);
    base_status := case when days_since < drift_after_days then 'healthy'
                        when days_since < at_risk_after_days then 'drifting'
                        else 'at_risk' end;
  end if;
  return next;
end;
$$;

create or replace function public.clicktide_rhythm_reason(
  p_status text, p_basis text, p_visits int, p_gaps int, p_expected numeric, p_source text,
  p_var numeric, p_days_since int, p_ratio numeric, p_seasonal boolean, p_recovered_via text)
returns text language sql immutable set search_path to 'public' as $$
  select concat_ws(' ',
    case
      when p_basis = 'none' then 'No visits recorded yet.'
      when p_source = 'observed' then format('Usually visits every %s days (median of %s gaps, %s).',
           trim(to_char(p_expected,'FM9990.0')), p_gaps,
           case when coalesce(p_var,0) <= 0.35 then 'very consistent' when coalesce(p_var,0) <= 0.7 then 'fairly consistent' else 'irregular' end)
      when p_source = 'summary_average' then format('About every %s days, averaged from their first and last visit (individual visit dates not stored yet).',
           trim(to_char(p_expected,'FM9990.0')))
      when p_source = 'blended' then format('Only %s visits so far, so their usual gap (about %s days) blends their own history with your business''s typical rhythm.',
           p_visits, trim(to_char(p_expected,'FM9990')))
      else format('%s — no personal rhythm yet. Estimated from your %s: about %s days between visits.',
           case when p_visits = 1 then 'Only 1 visit' else 'Too little history' end,
           case p_source when 'business' then 'customers'' typical gap' when 'category' then 'business type' else 'default' end,
           trim(to_char(p_expected,'FM9990')))
    end,
    case when p_days_since is not null then format('Last visit %s day%s ago (%s× their usual gap).',
           p_days_since, case when p_days_since = 1 then '' else 's' end, trim(to_char(p_ratio,'FM9990.0'))) end,
    case p_status
      when 'recovered' then case when p_recovered_via = 'winback' then 'Came back after a win-back message.' else 'Came back after drifting.' end
      when 'drifting'  then 'Starting to drift past their normal rhythm.'
      when 'at_risk'   then 'Well past their normal rhythm.'
      else null end,
    case when p_seasonal then 'Their history has long breaks followed by returns — may be seasonal.' end)
$$;

-- ---------------------------------------------------------------------------
-- Phase 2 engine: evaluate one business (writes only the new tables)
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_refresh_rhythm(p_user uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_tz text; v_today date; v_cat text; v_churn int;
  v_base numeric; v_base_src text; v_n_obs int;
  c record; r record; prev record; v_status text; v_since timestamptz; v_via text;
  v_reason text; v_legacy boolean; v_avg_spend numeric; v_avg_visits numeric; v_hist date[];
  v_counts jsonb := '{}'::jsonb; v_changes int := 0;
begin
  if p_user is null then return jsonb_build_object('error','no user'); end if;
  select clicktide_state_tz(b.state), clicktide_category_of(b.business_type), coalesce(b.churn_days, 60)
    into v_tz, v_cat, v_churn from clicktide b where b.user_id = p_user limit 1;
  v_tz := coalesce(v_tz, 'America/New_York'); v_cat := coalesce(v_cat, 'other'); v_churn := coalesce(v_churn, 60);
  v_today := (p_now at time zone v_tz)::date;

  -- Business rhythm = median of its customers' own learned medians (≥3 gaps each),
  -- once at least 5 customers have one; otherwise the business-type starting estimate.
  with gaps as (
    select customer_id, (visited_on - lag(visited_on) over (partition by customer_id order by visited_on))::numeric gap
    from customer_visits where user_id = p_user and visited_on <= v_today
  ), per as (
    select customer_id, percentile_cont(0.5) within group (order by gap) med, count(*) n
    from gaps where gap is not null group by customer_id having count(*) >= 3
  )
  select percentile_cont(0.5) within group (order by med), count(*) into v_base, v_n_obs from per;
  if coalesce(v_n_obs,0) >= 5 and v_base > 0 then v_base_src := 'business';
  else
    select typical_interval_days into v_base from retention_category_priors where category = v_cat;
    v_base_src := 'category';
    if v_base is null then v_base := 30; v_base_src := 'default'; end if;
  end if;

  -- Legacy rule inputs (for the shadow comparison only).
  select coalesce(avg(total_spent) filter (where coalesce(total_spent,0) > 0), 500),
         coalesce(avg(coalesce(visits,order_count,0)) filter (where coalesce(visits,order_count,0) > 0), 5)
    into v_avg_spend, v_avg_visits from customers where user_id = p_user;

  for c in
    select cu.id, cu.visits, cu.order_count, cu.first_order_at, cu.last_visit_at, cu.last_order_at,
           cu.total_spent, cu.satisfaction_score, cu.prev_satisfaction_score
    from customers cu where cu.user_id = p_user
  loop
    select array_agg(visited_on order by visited_on) into v_hist from customer_visits where customer_id = c.id;
    -- Use the visit ledger once it holds real history; otherwise the summary counters.
    if coalesce(array_length(v_hist,1),0) < 2 and coalesce(c.visits, c.order_count, 0) >= 2 then v_hist := null; end if;

    select * into r from clicktide_rhythm_core(
      v_hist, coalesce(c.visits, c.order_count, 0),
      (c.first_order_at at time zone v_tz)::date,
      (coalesce(c.last_visit_at, c.last_order_at) at time zone v_tz)::date,
      v_base, v_base_src, v_today);

    select * into prev from customer_rhythm where customer_id = c.id;
    v_status := r.base_status; v_via := null;

    if r.base_status = 'healthy' then
      -- Recovered = came back after being flagged (by this engine, or after a win-back send).
      if prev.status in ('drifting','at_risk') then
        v_status := 'recovered';
      elsif prev.status = 'recovered'
            and p_now - prev.status_since < make_interval(days => greatest(30, ceil(2 * r.expected_interval)::int)) then
        v_status := 'recovered';
      elsif exists (
        select 1 from campaign_sends s join campaigns k on k.id = s.campaign_id
        where s.customer_id = c.id and s.status = 'sent'
          and k.trigger ~* 'inactive|win[- ]?back|churn'
          and coalesce(c.last_visit_at, c.last_order_at) > s.sent_at
          and coalesce(c.last_visit_at, c.last_order_at) > p_now - interval '30 days') then
        v_status := 'recovered'; v_via := 'winback';
      end if;
      if v_status = 'recovered' and v_via is null and exists (
        select 1 from campaign_sends s join campaigns k on k.id = s.campaign_id
        where s.customer_id = c.id and s.status = 'sent' and k.trigger ~* 'inactive|win[- ]?back|churn'
          and coalesce(c.last_visit_at, c.last_order_at) > s.sent_at) then v_via := 'winback'; end if;
    end if;

    v_since := case when prev.status is not distinct from v_status then prev.status_since else p_now end;
    v_reason := clicktide_rhythm_reason(v_status, r.data_basis, r.visits_observed, r.gaps_used, r.expected_interval,
                  r.interval_source, r.variability, r.days_since, r.overdue_ratio, r.seasonal_hint, v_via);
    select d.drifting into v_legacy from clicktide_drift_eval(p_now, v_churn, v_avg_spend, v_avg_visits,
           coalesce(c.last_visit_at, c.last_order_at), c.first_order_at, coalesce(c.visits, c.order_count, 0),
           coalesce(c.total_spent,0)::double precision, coalesce(c.satisfaction_score,0), coalesce(c.prev_satisfaction_score,0)) d;

    insert into customer_rhythm as cr (customer_id, user_id, computed_at, data_basis, visits_observed, gaps_used, breaks_excluded,
      expected_interval, interval_source, variability, confidence, last_visit_on, days_since, overdue_ratio,
      drift_after_days, at_risk_after_days, status, status_since, seasonal_hint, reason, legacy_drifting)
    values (c.id, p_user, p_now, r.data_basis, r.visits_observed, r.gaps_used, r.breaks_excluded,
      r.expected_interval, r.interval_source, r.variability, r.confidence, r.last_visit_on, r.days_since, r.overdue_ratio,
      r.drift_after_days, r.at_risk_after_days, v_status, v_since, r.seasonal_hint, v_reason, v_legacy)
    on conflict (customer_id) do update set
      computed_at = excluded.computed_at, data_basis = excluded.data_basis, visits_observed = excluded.visits_observed,
      gaps_used = excluded.gaps_used, breaks_excluded = excluded.breaks_excluded, expected_interval = excluded.expected_interval,
      interval_source = excluded.interval_source, variability = excluded.variability, confidence = excluded.confidence,
      last_visit_on = excluded.last_visit_on, days_since = excluded.days_since, overdue_ratio = excluded.overdue_ratio,
      drift_after_days = excluded.drift_after_days, at_risk_after_days = excluded.at_risk_after_days,
      status = excluded.status, status_since = excluded.status_since, seasonal_hint = excluded.seasonal_hint,
      reason = excluded.reason, legacy_drifting = excluded.legacy_drifting;

    if prev.status is distinct from v_status then
      insert into customer_status_events(user_id, customer_id, from_status, to_status, occurred_at, days_since, expected_interval, overdue_ratio, reason)
      values (p_user, c.id, prev.status, v_status, p_now, r.days_since, r.expected_interval, r.overdue_ratio, v_reason);
      v_changes := v_changes + 1;
    end if;
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb(coalesce((v_counts->>v_status)::int,0) + 1));
  end loop;

  return jsonb_build_object('user_id', p_user, 'today', v_today, 'baseline_days', round(v_base,1),
                            'baseline_source', v_base_src, 'statuses', v_counts, 'status_changes', v_changes);
end;
$$;
revoke all on function public.clicktide_refresh_rhythm(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.clicktide_refresh_rhythm(uuid,timestamptz) to service_role;

create or replace function public.clicktide_refresh_rhythm_all()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare u uuid; n int := 0;
begin
  for u in select distinct user_id from customers where user_id is not null loop
    perform clicktide_refresh_rhythm(u); n := n + 1;
  end loop;
  return jsonb_build_object('businesses', n, 'at', now());
end;
$$;
revoke all on function public.clicktide_refresh_rhythm_all() from public, anon, authenticated;
grant execute on function public.clicktide_refresh_rhythm_all() to service_role;

-- Staff-only shadow comparison: new engine vs the current dashboard rule.
create or replace function public.clicktide_rhythm_shadow_compare()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb;
begin
  if not clicktide_is_staff(array['admin','support']) then return jsonb_build_object('error','forbidden'); end if;
  select jsonb_build_object(
    'customers', count(*),
    'by_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from customer_rhythm group by 1) s),
    'by_confidence', (select jsonb_object_agg(confidence, n) from (select confidence, count(*) n from customer_rhythm group by 1) s),
    'agree', count(*) filter (where (status in ('drifting','at_risk')) = coalesce(legacy_drifting,false)),
    'new_flags_legacy_missed', count(*) filter (where status in ('drifting','at_risk') and not coalesce(legacy_drifting,false)),
    'legacy_flags_new_clears', count(*) filter (where status not in ('drifting','at_risk') and coalesce(legacy_drifting,false))
  ) into r from customer_rhythm;
  return r;
end;
$$;
revoke all on function public.clicktide_rhythm_shadow_compare() from public, anon;
grant execute on function public.clicktide_rhythm_shadow_compare() to authenticated;
