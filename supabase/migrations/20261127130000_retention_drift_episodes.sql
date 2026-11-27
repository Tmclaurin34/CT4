-- Retention engine: drift episodes (2026-11-27). Additive column; refresh function updated.
alter table public.customer_rhythm add column if not exists episode_started_at timestamptz;
comment on column public.customer_rhythm.episode_started_at is
  'When the current drift episode began (first slipped past their rhythm); null while healthy/recovered. Win-backs: one per episode.';

create or replace function public.clicktide_refresh_rhythm(p_user uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_tz text; v_today date; v_cat text; v_churn int;
  v_base numeric; v_base_src text; v_n_obs int;
  c record; r record; prev record; v_status text; v_since timestamptz; v_via text;
  v_reason text; v_legacy boolean; v_episode timestamptz; v_avg_spend numeric; v_avg_visits numeric; v_hist date[];
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
    -- A drift episode starts when they first slip past their rhythm and lasts (through
    -- drifting -> at_risk) until they come back; win-backs are limited to one per episode.
    v_episode := case when v_status in ('drifting','at_risk') then
                   case when prev.status in ('drifting','at_risk') then coalesce(prev.episode_started_at, prev.status_since) else p_now end
                 end;
    v_reason := clicktide_rhythm_reason(v_status, r.data_basis, r.visits_observed, r.gaps_used, r.expected_interval,
                  r.interval_source, r.variability, r.days_since, r.overdue_ratio, r.seasonal_hint, v_via);
    select d.drifting into v_legacy from clicktide_drift_eval(p_now, v_churn, v_avg_spend, v_avg_visits,
           coalesce(c.last_visit_at, c.last_order_at), c.first_order_at, coalesce(c.visits, c.order_count, 0),
           coalesce(c.total_spent,0)::double precision, coalesce(c.satisfaction_score,0), coalesce(c.prev_satisfaction_score,0)) d;

    insert into customer_rhythm as cr (customer_id, user_id, computed_at, data_basis, visits_observed, gaps_used, breaks_excluded,
      expected_interval, interval_source, variability, confidence, last_visit_on, days_since, overdue_ratio,
      drift_after_days, at_risk_after_days, status, status_since, seasonal_hint, reason, legacy_drifting, episode_started_at)
    values (c.id, p_user, p_now, r.data_basis, r.visits_observed, r.gaps_used, r.breaks_excluded,
      r.expected_interval, r.interval_source, r.variability, r.confidence, r.last_visit_on, r.days_since, r.overdue_ratio,
      r.drift_after_days, r.at_risk_after_days, v_status, v_since, r.seasonal_hint, v_reason, v_legacy, v_episode)
    on conflict (customer_id) do update set
      computed_at = excluded.computed_at, data_basis = excluded.data_basis, visits_observed = excluded.visits_observed,
      gaps_used = excluded.gaps_used, breaks_excluded = excluded.breaks_excluded, expected_interval = excluded.expected_interval,
      interval_source = excluded.interval_source, variability = excluded.variability, confidence = excluded.confidence,
      last_visit_on = excluded.last_visit_on, days_since = excluded.days_since, overdue_ratio = excluded.overdue_ratio,
      drift_after_days = excluded.drift_after_days, at_risk_after_days = excluded.at_risk_after_days,
      status = excluded.status, status_since = excluded.status_since, seasonal_hint = excluded.seasonal_hint,
      reason = excluded.reason, legacy_drifting = excluded.legacy_drifting, episode_started_at = excluded.episode_started_at;

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
