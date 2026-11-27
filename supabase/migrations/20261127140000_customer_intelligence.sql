-- Retention engine phase 4: Customer Intelligence page.
-- One read-only RPC over customer_rhythm (the rhythm engine's output) + customers.
-- SECURITY INVOKER on purpose: the caller's own row-level security applies, so the
-- owner-only / staff-access policies and the owner MFA (aal2) restrictive policies on
-- customers and customer_rhythm keep working exactly as they do for direct reads.
-- Nothing here writes data.

create or replace function public.clicktide_customer_intelligence(
  p_status text default 'all',      -- all | healthy | drifting | at_risk | recovered | no_history | needs_contact
  p_q      text default '',
  p_sort   text default 'priority', -- priority | overdue | spend | recent
  p_limit  int  default 50,
  p_offset int  default 0)
returns json
language plpgsql
stable
security invoker
set search_path to 'public'
as $function$
declare
  uid    uuid := auth.uid();
  v_q    text := nullif(lower(btrim(coalesce(p_q,''))),'');
  v_st   text := coalesce(nullif(p_status,''),'all');
  v_sort text := coalesce(nullif(p_sort,''),'priority');
  v_lim  int  := least(greatest(coalesce(p_limit,50),1),200);
  v_off  int  := greatest(coalesce(p_offset,0),0);
  v_big  numeric;
  result json;
begin
  if uid is null then
    return json_build_object('error','unauthorized');
  end if;

  -- "big spender" line for the next-action advice: top quarter of this business's spend
  select coalesce(percentile_cont(0.75) within group (order by coalesce(total_spent,0)), 0)
    into v_big
  from customers where user_id = uid and coalesce(total_spent,0) > 0;

  with base as (
    select c.id, c.name, c.email, c.phone,
      coalesce(c.total_spent,0)::numeric          as spend,
      coalesce(c.visits, c.order_count, 0)        as visits,
      (c.email is not null and length(btrim(c.email)) > 0
        and c.email_unsubscribed_at is null)      as can_email,
      (length(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')) >= 10
        and coalesce(c.sms_consent,false) = true
        and c.sms_unsubscribed_at is null)        as can_text,
      r.status, r.status_since, r.confidence, r.expected_interval, r.interval_source,
      r.variability, r.visits_observed, r.last_visit_on, r.drift_after_days, r.at_risk_after_days,
      r.seasonal_hint, r.reason, r.computed_at,
      -- days since last visit, moved forward to today (the engine refreshes at least nightly)
      case when r.days_since is null then null
           else r.days_since + greatest(0, (now()::date - r.computed_at::date)) end as days_live
    from customers c
    join customer_rhythm r on r.customer_id = c.id
    where c.user_id = uid and r.user_id = uid
  ), enriched as (
    select b.*,
      case when b.days_live is null or b.expected_interval is null then null
           else round(b.days_live - b.expected_interval)::int end                        as days_vs_usual,
      case
        when b.status in ('drifting','at_risk') and not b.can_email and not b.can_text
          then 'Add an email or phone so Clicktide can reach them'
        when b.status = 'at_risk' and b.spend >= v_big and v_big > 0
          then 'High-value and well past their rhythm: send a gift or postcard'
        when b.status = 'at_risk'
          then 'Well past their rhythm: send a win-back offer'
        when b.status = 'drifting' and b.confidence = 'insufficient'
          then 'Only one visit so far: a friendly welcome-back note'
        when b.status = 'drifting'
          then 'Just past their rhythm: a quick check-in message'
        when b.status = 'recovered'
          then 'Back again: say thanks, no win-back needed'
        when b.status = 'no_history'
          then 'No visits recorded yet'
        else 'On rhythm: no action needed'
      end                                                                                as next_action,
      case b.status when 'at_risk' then 1 when 'drifting' then 2 when 'recovered' then 3
                    when 'healthy' then 4 else 5 end                                    as prio
    from base b
  ), filtered as (
    select * from enriched e
    where (v_st = 'all'
        or (v_st = 'needs_contact' and e.status in ('drifting','at_risk') and not e.can_email and not e.can_text)
        or e.status = v_st)
      and (v_q is null or lower(coalesce(e.name,'')||' '||coalesce(e.email,'')||' '||coalesce(e.phone,'')) like '%'||v_q||'%')
  ), page as (
    select * from filtered f
    order by
      case when v_sort = 'priority' then f.prio end asc,
      case when v_sort = 'priority' then f.spend end desc,
      case when v_sort = 'overdue'  then coalesce(f.days_vs_usual,-100000) end desc,
      case when v_sort = 'spend'    then f.spend end desc,
      case when v_sort = 'recent'   then f.status_since end desc,
      f.id
    limit v_lim offset v_off
  )
  select json_build_object(
    'engine', 'rhythm',
    'updated_at', (select max(computed_at) from base),
    'counts', (select json_build_object(
        'all',        count(*),
        'healthy',    count(*) filter (where status = 'healthy'),
        'drifting',   count(*) filter (where status = 'drifting'),
        'at_risk',    count(*) filter (where status = 'at_risk'),
        'recovered',  count(*) filter (where status = 'recovered'),
        'no_history', count(*) filter (where status = 'no_history'),
        'needs_contact', count(*) filter (where status in ('drifting','at_risk') and not can_email and not can_text),
        'spend_at_stake', coalesce(round(sum(spend) filter (where status in ('drifting','at_risk')),2),0),
        'conf_high',   count(*) filter (where confidence = 'high'),
        'conf_medium', count(*) filter (where confidence = 'medium'),
        'conf_low',    count(*) filter (where confidence = 'low'),
        'conf_insufficient', count(*) filter (where confidence = 'insufficient'))
      from enriched),
    'recovered_30d', (select count(distinct customer_id) from customer_status_events
                       where user_id = uid and to_status = 'recovered' and occurred_at >= now() - interval '30 days'),
    'total', (select count(*) from filtered),
    'rows', coalesce((select json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'email', p.email, 'phone', p.phone,
        'status', p.status, 'status_since', p.status_since, 'confidence', p.confidence,
        'expected_interval', round(p.expected_interval,1), 'interval_source', p.interval_source,
        'visits_observed', p.visits_observed, 'visits', p.visits, 'spend', p.spend,
        'last_visit_on', p.last_visit_on, 'days_since', p.days_live, 'days_vs_usual', p.days_vs_usual,
        'drift_after_days', round(p.drift_after_days), 'seasonal_hint', p.seasonal_hint,
        'can_email', p.can_email, 'can_text', p.can_text,
        'reason', p.reason, 'next_action', p.next_action)
      order by
        case when v_sort = 'priority' then p.prio end asc,
        case when v_sort = 'priority' then p.spend end desc,
        case when v_sort = 'overdue'  then coalesce(p.days_vs_usual,-100000) end desc,
        case when v_sort = 'spend'    then p.spend end desc,
        case when v_sort = 'recent'   then p.status_since end desc,
        p.id) from page p), '[]'::json)
  ) into result;
  return result;
end;
$function$;

revoke all on function public.clicktide_customer_intelligence(text,text,text,int,int) from public, anon;
grant execute on function public.clicktide_customer_intelligence(text,text,text,int,int) to authenticated;
