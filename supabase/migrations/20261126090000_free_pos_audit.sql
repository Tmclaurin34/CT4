-- Free POS Revenue Recovery Audit funnel (2026-11-26)
--
-- 1. clicktide_drift_eval(): the ONE definition of per-customer drift / VIP /
--    new / unhappy / win-back. Lifted verbatim out of clicktide_customers(), which
--    now calls it, so the Customers page and the free audit report can never
--    disagree about who is "drifting".
-- 2. pos_audits: one row per audit run (status, real progress stage, report
--    snapshot of aggregates only, ad attribution). Owner can read own rows;
--    only the service role writes.
-- 3. pos_audit_facts: transient, PII-free per-customer facts (visits, spend,
--    first/last order) that the analysis runs over. Service-role only; deleted
--    as soon as the report is built.
-- 4. funnel_events: first-party funnel analytics (landing visit -> paid).
--    Anyone may INSERT a whitelisted event; nobody but staff can read.
-- 5. clicktide_audit_build_report(): aggregates facts -> report jsonb.
-- 6. clicktide_audit_funnel(): staff-only funnel metrics by campaign/creative.

-- ---------------------------------------------------------------------------
-- 1. Shared drift definition
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_drift_eval(
  p_now timestamptz, p_churn int, p_avg_spend numeric, p_avg_visits numeric,
  p_lv timestamptz, p_first timestamptz, p_vis int, p_spend double precision,
  p_sat int, p_psat int)
returns table(eff_churn int, since_visit int, spend_norm double precision, freq_norm numeric,
              recency_norm numeric, recovered boolean, drifting boolean, high_value boolean,
              score int, is_unhappy boolean, is_vip boolean, is_new boolean, is_winback boolean)
language sql immutable
set search_path to 'public'
as $$
  with cadence as (
    select
      case when p_vis >= 2 and p_first is not null and p_lv is not null and p_lv > p_first
           then greatest(14, least(120, round((extract(epoch from (p_lv - p_first))/86400.0/(p_vis-1)) * 1.5)::int))
           else p_churn end as eff_churn
  ),
  norm as (
    select c.eff_churn,
      case when p_lv is null then c.eff_churn
           else floor(extract(epoch from (p_now - p_lv))/86400)::int end as since_visit,
      least(p_spend / (p_avg_spend * 2), 1) * 100 as spend_norm,
      least(p_vis  / (p_avg_visits * 2), 1) * 100 as freq_norm
    from cadence c
  ),
  flags as (
    select n.*,
      greatest(0, 1 - (n.since_visit::numeric / n.eff_churn)) * 100 as recency_norm,
      (p_psat > 0 and p_psat <= 2 and p_sat >= 4)                 as recovered,
      (p_lv is not null and n.since_visit >= n.eff_churn)         as drifting,
      (n.spend_norm >= 60 or n.freq_norm >= 60)                   as high_value
    from norm n
  ),
  scored as (
    select f.*,
      least(round(f.spend_norm*0.33 + f.recency_norm*0.34 + f.freq_norm*0.33
                  + case when f.recovered then 10 else 0 end)::int, 100) as score
    from flags f
  )
  select s.eff_churn, s.since_visit, s.spend_norm, s.freq_norm, s.recency_norm,
         s.recovered, s.drifting, s.high_value, s.score,
         (p_sat > 0 and p_sat <= 2)                                             as is_unhappy,
         (s.score >= 75 or s.high_value)                                        as is_vip,
         (not (p_sat > 0 and p_sat <= 2)
           and not (s.recovered and not s.drifting)
           and not (s.since_visit >= s.eff_churn)
           and s.score < 50)                                                    as is_new,
         (s.drifting and s.high_value and not (p_sat > 0 and p_sat <= 2))       as is_winback
  from scored s
$$;
revoke all on function public.clicktide_drift_eval(timestamptz,int,numeric,numeric,timestamptz,timestamptz,int,double precision,int,int) from public, anon;
grant execute on function public.clicktide_drift_eval(timestamptz,int,numeric,numeric,timestamptz,timestamptz,int,double precision,int,int) to authenticated, service_role;

-- clicktide_customers(): same signature + same output, now using the shared eval.
create or replace function public.clicktide_customers(p_churn integer DEFAULT 60, p_segment text DEFAULT 'all'::text, p_q text DEFAULT ''::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid        uuid := auth.uid();
  v_churn    int  := greatest(coalesce(p_churn,60),1);
  v_now      timestamptz := now();
  v_avg_spend  numeric;
  v_avg_visits numeric;
  v_q        text := nullif(trim(coalesce(p_q,'')),'');
  v_lim      int  := least(greatest(coalesce(p_limit,100),1),500);
  v_off      int  := greatest(coalesce(p_offset,0),0);
  result     json;
begin
  if uid is null then
    return json_build_object('error','unauthorized');
  end if;

  select
    coalesce(avg(total_spent) filter (where coalesce(total_spent,0) > 0), 500),
    coalesce(avg(coalesce(visits,order_count,0)) filter (where coalesce(visits,order_count,0) > 0), 5)
    into v_avg_spend, v_avg_visits
  from customers
  where user_id = uid;

  with base as (
    select c.*,
      coalesce(c.last_visit_at, c.last_order_at)  as lv,
      coalesce(c.total_spent,0)                   as spend,
      coalesce(c.visits, c.order_count, 0)        as vis,
      coalesce(c.satisfaction_score,0)            as sat,
      coalesce(c.prev_satisfaction_score,0)       as psat,
      (c.email is not null and length(btrim(c.email)) > 0)                                  as can_email,
      (length(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')) >= 10
        and coalesce(c.sms_consent,false) = true
        and c.sms_unsubscribed_at is null)                                                  as can_text,
      (c.address is not null and btrim(c.address) <> ''
        and c.city is not null and btrim(c.city) <> ''
        and c.state is not null and btrim(c.state) <> ''
        and c.zip is not null and btrim(c.zip) <> '')                                       as can_mail
    from customers c
    where c.user_id = uid
  ),
  tagged as (
    select b.*, d.eff_churn, d.since_visit, d.drifting, d.score,
      d.is_unhappy, d.is_vip, d.is_new, d.is_winback,
      case when not (b.can_email or b.can_text) then 'nocontact'
           when not b.can_mail then 'noaddress'
           else 'full' end                                                        as reach,
      (not (b.can_email or b.can_text))                                            as is_nocontact,
      (not b.can_mail)                                                             as is_noaddress
    from base b
    cross join lateral public.clicktide_drift_eval(v_now, v_churn, v_avg_spend, v_avg_visits,
                                                   b.lv, b.first_order_at, b.vis, b.spend, b.sat, b.psat) d
  ),
  scoped as (
    select * from tagged t
    where (v_q is null
           or t.name  ilike '%'||v_q||'%'
           or t.email ilike '%'||v_q||'%'
           or t.phone ilike '%'||v_q||'%')
      and (p_from is null or t.lv >= p_from)
      and (p_to   is null or t.lv <= p_to)
  ),
  matched as (
    select * from scoped t
    where p_segment = 'all'
       or (p_segment = 'drifting'  and t.drifting)
       or (p_segment = 'vip'       and t.is_vip)
       or (p_segment = 'unhappy'   and t.is_unhappy)
       or (p_segment = 'new'       and t.is_new)
       or (p_segment = 'nocontact' and t.is_nocontact)
       or (p_segment = 'noaddress' and t.is_noaddress)
  )
  select json_build_object(
    'avg_spend',  v_avg_spend,
    'avg_visits', v_avg_visits,
    'churn',      v_churn,
    'total',      (select count(*) from matched),
    'seg', json_build_object(
      'all',       (select count(*) from scoped),
      'drifting',  (select count(*) from scoped where drifting),
      'vip',       (select count(*) from scoped where is_vip),
      'unhappy',   (select count(*) from scoped where is_unhappy),
      'new',       (select count(*) from scoped where is_new),
      'nocontact', (select count(*) from scoped where is_nocontact),
      'noaddress', (select count(*) from scoped where is_noaddress)
    ),
    'alert', json_build_object(
      'unhappy',         (select count(*) from tagged where is_unhappy),
      'unhappy_names',   (select coalesce(json_agg(name),'[]'::json) from (select name from tagged where is_unhappy order by since_visit desc limit 3) u),
      'winback',         (select count(*) from tagged where is_winback),
      'winback_names',   (select coalesce(json_agg(name),'[]'::json) from (select name from tagged where is_winback order by spend desc limit 3) w),
      'nocontact',       (select count(*) from tagged where is_nocontact),
      'nocontact_names', (select coalesce(json_agg(name),'[]'::json) from (select name from tagged where is_nocontact order by spend desc limit 3) r)
    ),
    'rows', (
      select coalesce(json_agg(to_json(r)), '[]'::json)
      from (
        select id, created_at, name, email, phone, total_spent, status, visits,
               order_count, satisfaction_score, prev_satisfaction_score,
               last_visit_at, last_order_at, first_order_at, loyalty_score, loyalty_tier,
               address, city, state, zip, sms_consent, sms_unsubscribed_at,
               reach, can_email, can_text, can_mail, eff_churn
        from matched
        order by created_at desc
        limit v_lim offset v_off
      ) r
    )
  ) into result;

  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2-4. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.pos_audits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  source        text not null default 'pos' check (source in ('pos','csv')),
  platform      text,
  status        text not null default 'running'
                check (status in ('running','complete','insufficient_data','failed')),
  stage         text not null default 'connecting'
                check (stage in ('connecting','importing','analyzing','done','failed')),
  progress      jsonb not null default '{}'::jsonb,   -- real counters from the import
  error         text,
  report        jsonb,                                -- aggregates only, never PII
  attribution   jsonb not null default '{}'::jsonb,   -- utm_*, variant, session id
  report_viewed_at timestamptz
);
create index if not exists pos_audits_user_idx on public.pos_audits(user_id, created_at desc);
alter table public.pos_audits enable row level security;
drop policy if exists pos_audits_owner_select on public.pos_audits;
create policy pos_audits_owner_select on public.pos_audits for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists pos_audits_staff_select on public.pos_audits;
create policy pos_audits_staff_select on public.pos_audits for select to authenticated
  using (public.clicktide_is_staff(array['admin','support']));
revoke insert, update, delete on public.pos_audits from anon, authenticated;
grant select on public.pos_audits to authenticated;

create table if not exists public.pos_audit_facts (
  audit_id  uuid not null references public.pos_audits(id) on delete cascade,
  visits    int not null check (visits >= 1),
  spend     numeric not null default 0,
  first_at  timestamptz not null,
  last_at   timestamptz not null
);
create index if not exists pos_audit_facts_audit_idx on public.pos_audit_facts(audit_id);
alter table public.pos_audit_facts enable row level security;   -- no policies: service role only
revoke all on public.pos_audit_facts from anon, authenticated;

create table if not exists public.funnel_events (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  session_id  text not null check (length(session_id) between 8 and 64),
  event       text not null check (event in (
                'landing_view','cta_click','signup_started','signup_completed',
                'pos_selected','connect_started','connect_completed','connect_failed',
                'audit_started','audit_completed','audit_failed','report_viewed',
                'pricing_viewed','checkout_started','csv_started')),
  user_id     uuid default auth.uid(),
  audit_id    uuid,
  variant     text check (variant is null or length(variant) <= 32),
  platform    text check (platform is null or length(platform) <= 32),
  utm         jsonb not null default '{}'::jsonb check (length(utm::text) <= 1500),
  path        text check (path is null or length(path) <= 200)
);
create index if not exists funnel_events_created_idx on public.funnel_events(created_at desc);
create index if not exists funnel_events_session_idx on public.funnel_events(session_id);
alter table public.funnel_events enable row level security;
drop policy if exists funnel_events_insert on public.funnel_events;
create policy funnel_events_insert on public.funnel_events for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
drop policy if exists funnel_events_staff_select on public.funnel_events;
create policy funnel_events_staff_select on public.funnel_events for select to authenticated
  using (public.clicktide_is_staff(array['admin','support']));
grant insert on public.funnel_events to anon, authenticated;
grant usage on sequence public.funnel_events_id_seq to anon, authenticated;
grant select on public.funnel_events to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Report builder (service role only). Facts -> aggregates, using the shared
--    drift definition. Satisfaction isn't available from POS data, so the
--    unhappy segment is reported as unavailable rather than zero.
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_audit_build_report(p_audit uuid, p_churn int default 60)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_churn int := greatest(coalesce(p_churn,60),1);
  v_avg_spend numeric; v_avg_visits numeric;
  v_n int; v_repeat int;
  r jsonb;
begin
  select count(*), count(*) filter (where visits >= 2),
         coalesce(avg(spend) filter (where spend > 0), 500),
         coalesce(avg(visits) filter (where visits > 0), 5)
    into v_n, v_repeat, v_avg_spend, v_avg_visits
  from pos_audit_facts where audit_id = p_audit;

  with t as (
    select f.*, d.*
    from pos_audit_facts f
    cross join lateral clicktide_drift_eval(v_now, v_churn, v_avg_spend, v_avg_visits,
                                            f.last_at, f.first_at, f.visits, f.spend::double precision, 0, 0) d
    where f.audit_id = p_audit
  ),
  rep as (  -- repeat customers' own visit interval (days)
    select extract(epoch from (last_at - first_at))/86400.0/(visits-1) as gap
    from t where visits >= 2 and last_at > first_at
  )
  select jsonb_build_object(
    'generated_at', v_now,
    'churn_days_default', v_churn,
    'customers_analyzed', v_n,
    'repeat_customers', v_repeat,
    'one_time_customers', v_n - v_repeat,
    'total_historical_spend', round(coalesce((select sum(spend) from t),0)::numeric, 2),
    'avg_spend_per_customer', round(coalesce((select avg(spend) from t),0)::numeric, 2),
    'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t),0)::numeric, 2),
    'median_visit_gap_days', (select round(percentile_cont(0.5) within group (order by gap))::int from rep),
    'history_first_order', (select min(first_at) from t),
    'history_last_order',  (select max(last_at) from t),
    'drifting', jsonb_build_object(
      'count', (select count(*) from t where drifting),
      'repeat_count', (select count(*) from t where drifting and visits >= 2),
      'historical_spend', round(coalesce((select sum(spend) from t where drifting),0)::numeric, 2),
      'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t where drifting),0)::numeric, 2),
      'buckets', jsonb_build_object(   -- how far past their own normal rhythm
        'just_past',  (select count(*) from t where drifting and since_visit <  eff_churn * 1.5),
        'well_past',  (select count(*) from t where drifting and since_visit >= eff_churn * 1.5 and since_visit < eff_churn * 3),
        'long_gone',  (select count(*) from t where drifting and since_visit >= eff_churn * 3)
      )
    ),
    'high_priority', jsonb_build_object(   -- drifting AND high value (= win-back segment)
      'count', (select count(*) from t where is_winback),
      'historical_spend', round(coalesce((select sum(spend) from t where is_winback),0)::numeric, 2),
      'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t where is_winback),0)::numeric, 2)
    ),
    'vip', jsonb_build_object(
      'count', (select count(*) from t where is_vip),
      'drifting', (select count(*) from t where is_vip and drifting)
    ),
    'active_count', (select count(*) from t where not drifting),
    'new_count', (select count(*) from t where is_new),
    'unhappy', jsonb_build_object('available', false)
  ) into r;
  return r;
end;
$$;
revoke all on function public.clicktide_audit_build_report(uuid,int) from public, anon, authenticated;
grant execute on function public.clicktide_audit_build_report(uuid,int) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Funnel metrics for staff (ad dashboard).
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_audit_funnel(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days,30),1)); r jsonb;
begin
  if not public.clicktide_is_staff(array['admin','support']) then
    return jsonb_build_object('error','forbidden');
  end if;
  with ev as (
    select e.*, coalesce(e.utm->>'utm_campaign','(none)') as campaign,
           coalesce(e.utm->>'utm_content', e.variant, '(none)') as creative
    from funnel_events e where e.created_at >= v_since
  ),
  sess as (  -- the first-touch campaign/creative of each session
    select distinct on (session_id) session_id, campaign, creative
    from ev order by session_id, created_at
  ),
  users as (  -- sessions that became an account
    select distinct e.session_id, e.user_id from ev e where e.user_id is not null
  ),
  paid as (
    select u.session_id from users u join clicktide c on c.user_id = u.user_id
    where lower(coalesce(c.stripe_subscription_status,'')) in ('active','trialing')
  ),
  by_c as (
    select s.campaign, s.creative,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='landing_view')) as landing_visitors,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='cta_click')) as cta_clicks,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='signup_completed')) as signups,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='connect_started')) as connect_starts,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='connect_completed')) as connections,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='audit_completed')) as reports_completed,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='report_viewed')) as reports_viewed,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='pricing_viewed')) as pricing_views,
      count(distinct s.session_id) filter (where exists (select 1 from ev x where x.session_id=s.session_id and x.event='checkout_started')) as checkouts_started,
      count(distinct s.session_id) filter (where s.session_id in (select session_id from paid)) as paid_subscriptions
    from sess s group by 1,2
  )
  select jsonb_build_object('since', v_since,
    'rows', coalesce((select jsonb_agg(to_jsonb(b) order by b.landing_visitors desc) from by_c b), '[]'::jsonb)) into r;
  return r;
end;
$$;
revoke all on function public.clicktide_audit_funnel(int) from public, anon;
grant execute on function public.clicktide_audit_funnel(int) to authenticated;
