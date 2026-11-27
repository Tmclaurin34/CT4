-- Retention engine phase 3 (2026-11-27): every reader uses the one rhythm engine.
-- Additive columns only; two functions are replaced in place (same signatures).

-- Owner setting: win-back campaigns skip customers with only one visit (no personal
-- rhythm yet) unless the owner opts in.
alter table public.clicktide add column if not exists winback_include_estimated boolean not null default false;
comment on column public.clicktide.winback_include_estimated is
  'Retention engine: when true, win-back campaigns also reach customers whose rhythm is only estimated (one visit).';

-- Free audit facts can carry each customer's visit dates (no names/contacts), so the
-- audit runs the same engine as the dashboard. Older clients that don't send dates
-- fall back to first/last/visit-count, exactly like summary-only customers.
alter table public.pos_audit_facts add column if not exists visit_days date[];

-- ---------------------------------------------------------------------------
-- Dashboard Customers page: drift = the engine's status (legacy rule only as a
-- fallback for customers the engine hasn't evaluated yet).
-- ---------------------------------------------------------------------------
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
    select b.*, d.since_visit, d.score, d.is_unhappy, d.is_vip, d.is_new,
      coalesce(round(cr.drift_after_days)::int, d.eff_churn)                       as eff_churn,
      case when cr.customer_id is not null then cr.status in ('drifting','at_risk')
           else d.drifting end                                                     as drifting,
      (case when cr.customer_id is not null then cr.status in ('drifting','at_risk') else d.drifting end)
        and d.high_value and not d.is_unhappy                                      as is_winback,
      coalesce(cr.status, case when d.drifting then 'drifting' else 'healthy' end) as rhythm_status,
      coalesce(cr.confidence, 'low')                                               as rhythm_confidence,
      coalesce(cr.reason, '')                                                      as rhythm_reason,
      cr.expected_interval,
      case when cr.days_since is not null and cr.expected_interval is not null
           then greatest(0, round(cr.days_since - cr.expected_interval))::int end  as days_overdue,
      case when not (b.can_email or b.can_text) then 'nocontact'
           when not b.can_mail then 'noaddress'
           else 'full' end                                                        as reach,
      (not (b.can_email or b.can_text))                                            as is_nocontact,
      (not b.can_mail)                                                             as is_noaddress
    from base b
    cross join lateral public.clicktide_drift_eval(v_now, v_churn, v_avg_spend, v_avg_visits,
                                                   b.lv, b.first_order_at, b.vis, b.spend, b.sat, b.psat) d
    left join customer_rhythm cr on cr.customer_id = b.id
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
       or (p_segment = 'at_risk'   and t.rhythm_status = 'at_risk')
       or (p_segment = 'recovered' and t.rhythm_status = 'recovered')
       or (p_segment = 'healthy'   and t.rhythm_status = 'healthy')
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
    'engine',     'rhythm',
    'total',      (select count(*) from matched),
    'seg', json_build_object(
      'all',       (select count(*) from scoped),
      'drifting',  (select count(*) from scoped where drifting),
      'at_risk',   (select count(*) from scoped where rhythm_status = 'at_risk'),
      'recovered', (select count(*) from scoped where rhythm_status = 'recovered'),
      'healthy',   (select count(*) from scoped where rhythm_status = 'healthy'),
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
               reach, can_email, can_text, can_mail, eff_churn,
               rhythm_status, rhythm_confidence, rhythm_reason, expected_interval, days_overdue
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
-- Free audit report: same engine. Value (VIP / high spend) still comes from the
-- shared value scoring; drift comes only from clicktide_rhythm_core.
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_audit_build_report(p_audit uuid, p_churn int default 60)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_today date := (now() at time zone 'UTC')::date;
  v_churn int := greatest(coalesce(p_churn,60),1);
  v_user uuid; v_cat text; v_base numeric; v_src text; v_nobs int;
  v_avg_spend numeric; v_avg_visits numeric;
  v_n int; v_repeat int;
  r jsonb;
begin
  select user_id into v_user from pos_audits where id = p_audit;
  select clicktide_category_of(business_type) into v_cat from clicktide where user_id = v_user limit 1;

  select count(*), count(*) filter (where visits >= 2),
         coalesce(avg(spend) filter (where spend > 0), 500),
         coalesce(avg(visits) filter (where visits > 0), 5)
    into v_n, v_repeat, v_avg_spend, v_avg_visits
  from pos_audit_facts where audit_id = p_audit;

  -- Business rhythm from this business's own customers when 5+ have a learned rhythm.
  select percentile_cont(0.5) within group (order by x.expected_interval), count(*) into v_base, v_nobs
  from pos_audit_facts f
  cross join lateral clicktide_rhythm_core(f.visit_days, f.visits, (f.first_at at time zone 'UTC')::date,
                                           (f.last_at at time zone 'UTC')::date, 30, 'default', v_today) x
  where f.audit_id = p_audit and x.interval_source in ('observed','summary_average');
  if coalesce(v_nobs,0) >= 5 and v_base > 0 then v_src := 'business';
  else
    select typical_interval_days into v_base from retention_category_priors where category = coalesce(v_cat,'other');
    v_src := 'category';
    if v_base is null then v_base := 30; v_src := 'default'; end if;
  end if;

  with t as (
    select f.visits, f.spend, f.first_at, f.last_at, x.*, d.high_value, d.is_vip, d.is_new,
           (x.base_status in ('drifting','at_risk')) as drifting
    from pos_audit_facts f
    cross join lateral clicktide_rhythm_core(f.visit_days, f.visits, (f.first_at at time zone 'UTC')::date,
                                             (f.last_at at time zone 'UTC')::date, v_base, v_src, v_today) x
    cross join lateral clicktide_drift_eval(v_now, v_churn, v_avg_spend, v_avg_visits,
                                            f.last_at, f.first_at, f.visits, f.spend::double precision, 0, 0) d
    where f.audit_id = p_audit
  )
  select jsonb_build_object(
    'generated_at', v_now,
    'engine', 'rhythm',
    'baseline_days', round(v_base, 1),
    'baseline_source', v_src,
    'churn_days_default', v_churn,
    'customers_analyzed', v_n,
    'repeat_customers', v_repeat,
    'one_time_customers', v_n - v_repeat,
    'total_historical_spend', round(coalesce((select sum(spend) from t),0)::numeric, 2),
    'avg_spend_per_customer', round(coalesce((select avg(spend) from t),0)::numeric, 2),
    'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t),0)::numeric, 2),
    'median_visit_gap_days', (select round(percentile_cont(0.5) within group (order by expected_interval))::int
                                from t where interval_source in ('observed','summary_average')),
    'history_first_order', (select min(first_at) from t),
    'history_last_order',  (select max(last_at) from t),
    'drifting', jsonb_build_object(
      'count', (select count(*) from t where drifting),
      'repeat_count', (select count(*) from t where drifting and visits >= 2),
      'historical_spend', round(coalesce((select sum(spend) from t where drifting),0)::numeric, 2),
      'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t where drifting),0)::numeric, 2),
      'buckets', jsonb_build_object(
        'just_past',  (select count(*) from t where base_status = 'drifting'),
        'well_past',  (select count(*) from t where base_status = 'at_risk' and overdue_ratio < 4),
        'long_gone',  (select count(*) from t where base_status = 'at_risk' and overdue_ratio >= 4)
      )
    ),
    'high_priority', jsonb_build_object(
      'count', (select count(*) from t where drifting and high_value),
      'historical_spend', round(coalesce((select sum(spend) from t where drifting and high_value),0)::numeric, 2),
      'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t where drifting and high_value),0)::numeric, 2),
      'avg_90d_value', round(coalesce((select avg((spend / visits) *
            case when gaps_used >= 1 then least(90.0 / greatest(expected_interval, 7), 13) else 1 end)
          from t where drifting and high_value),0)::numeric, 2)
    ),
    'vip', jsonb_build_object(
      'count', (select count(*) from t where is_vip),
      'drifting', (select count(*) from t where is_vip and drifting)
    ),
    'active_count', (select count(*) from t where not drifting),
    'new_count', (select count(*) from t where is_new),
    'confidence', jsonb_build_object(
      'high', (select count(*) from t where confidence = 'high'),
      'medium', (select count(*) from t where confidence = 'medium'),
      'low', (select count(*) from t where confidence = 'low'),
      'insufficient', (select count(*) from t where confidence = 'insufficient')
    ),
    'unhappy', jsonb_build_object('available', false)
  ) into r;
  return r;
end;
$$;
revoke all on function public.clicktide_audit_build_report(uuid,int) from public, anon, authenticated;
grant execute on function public.clicktide_audit_build_report(uuid,int) to service_role;
