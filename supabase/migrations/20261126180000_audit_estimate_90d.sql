-- Free POS audit: the illustrative estimate now sizes a 3-month return to each
-- high-priority customer's own routine (report.high_priority.avg_90d_value).
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
      'avg_order_value', round(coalesce((select sum(spend)/nullif(sum(visits),0) from t where is_winback),0)::numeric, 2),
      -- What one returning high-priority customer is worth over 3 months if they pick
      -- their OWN old routine back up: their average order x the visits their own gap
      -- implies in 90 days (capped at weekly; one-time customers count as one visit).
      'avg_90d_value', round(coalesce((select avg(
          (spend / visits) *
          case when visits >= 2 and last_at > first_at
               then least(90.0 / greatest(extract(epoch from (last_at - first_at))/86400.0/(visits-1), 7), 13)
               else 1 end)
        from t where is_winback),0)::numeric, 2)
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
