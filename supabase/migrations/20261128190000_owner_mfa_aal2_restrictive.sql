-- Owner two-step (TOTP) enforced in the database, not only in the frontend.
-- An owner with a VERIFIED authenticator must present an aal2 JWT to read/write their data;
-- owners without one (incl. the Shopify reviewer test business) are unaffected.
-- service_role bypasses RLS and is unaffected. Supabase's recommended restrictive pattern.

-- Concurrency guard: the three RPC bodies below were copied from live on 2026-11-27.
-- If another session changed any of them since, stop instead of overwriting their change.
do $$
declare h text;
begin
  select string_agg(p.proname||'='||md5(pg_get_functiondef(p.oid)), ',' order by p.proname) into h
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('clicktide_customers','clicktide_shopify_usage_this_cycle','clicktide_winback_stats');
  if h is distinct from 'clicktide_customers=f97393761d67bc509627a48176c13c8e,clicktide_shopify_usage_this_cycle=4617fe4dc2f0ec957a72bf7746a20afc,clicktide_winback_stats=b90464245ba52225f2ae0f4060a66853' then
    raise exception 'owner_mfa_aal2: live RPC definitions changed since this migration was written (%). Re-generate it.', h;
  end if;
end $$;

create or replace function public.clicktide_owner_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not exists (
           select 1 from auth.mfa_factors f
            where f.user_id = auth.uid()
              and f.status = 'verified'
         );
$$;
comment on function public.clicktide_owner_mfa_ok() is
  'true when the caller is at aal2 or has no verified MFA factor. Used by restrictive owner_mfa_aal2 policies and owner RPCs.';
revoke all on function public.clicktide_owner_mfa_ok() from public, anon;
grant execute on function public.clicktide_owner_mfa_ok() to authenticated, service_role;


drop policy if exists owner_mfa_aal2 on public.ai_suggestions;
create policy owner_mfa_aal2 on public.ai_suggestions as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.alerts;
create policy owner_mfa_aal2 on public.alerts as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.brand_products;
create policy owner_mfa_aal2 on public.brand_products as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.business_profile_changes;
create policy owner_mfa_aal2 on public.business_profile_changes as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.campaign_sends;
create policy owner_mfa_aal2 on public.campaign_sends as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.campaigns;
create policy owner_mfa_aal2 on public.campaigns as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.clicktide;
create policy owner_mfa_aal2 on public.clicktide as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.customer_rhythm;
create policy owner_mfa_aal2 on public.customer_rhythm as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.customer_status_events;
create policy owner_mfa_aal2 on public.customer_status_events as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.customer_visits;
create policy owner_mfa_aal2 on public.customer_visits as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.customers;
create policy owner_mfa_aal2 on public.customers as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.email_suppressions;
create policy owner_mfa_aal2 on public.email_suppressions as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.email_templates;
create policy owner_mfa_aal2 on public.email_templates as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.message_events;
create policy owner_mfa_aal2 on public.message_events as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.oauth_states;
create policy owner_mfa_aal2 on public.oauth_states as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.platform_connections;
create policy owner_mfa_aal2 on public.platform_connections as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.pos_audits;
create policy owner_mfa_aal2 on public.pos_audits as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.shipments;
create policy owner_mfa_aal2 on public.shipments as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.sms_messages;
create policy owner_mfa_aal2 on public.sms_messages as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.survey_responses;
create policy owner_mfa_aal2 on public.survey_responses as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

drop policy if exists owner_mfa_aal2 on public.wallet;
create policy owner_mfa_aal2 on public.wallet as restrictive for all to authenticated
  using ((select public.clicktide_owner_mfa_ok()))
  with check ((select public.clicktide_owner_mfa_ok()));

-- clicktide_customers: live body unchanged except the mfa_required guard after the uid check
CREATE OR REPLACE FUNCTION public.clicktide_customers(p_churn integer DEFAULT 60, p_segment text DEFAULT 'all'::text, p_q text DEFAULT ''::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
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
    return json_build_object('error', 'unauthorized');
  end if;
  if not public.clicktide_owner_mfa_ok() then
    return json_build_object('error', 'mfa_required');
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

-- clicktide_winback_stats: live body unchanged except the mfa_required guard after the uid check
CREATE OR REPLACE FUNCTION public.clicktide_winback_stats(p_window_days integer DEFAULT 30)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid   uuid := auth.uid();
  v_win int  := greatest(coalesce(p_window_days, 30), 1);
  result json;
begin
  if uid is null then
    return json_build_object('error', 'unauthorized');
  end if;
  if not public.clicktide_owner_mfa_ok() then
    return json_build_object('error', 'mfa_required');
  end if;

  with sends as (
    select customer_id, min(sent_at) as first_sent, max(sent_at) as last_sent
    from campaign_sends
    where user_id = uid and status = 'sent' and customer_id is not null
    group by customer_id
  ),
  joined as (
    select c.id, c.name, c.last_order_amount, c.total_spent,
           coalesce(c.visits, c.order_count, 0) as vis,
           coalesce(c.last_visit_at, c.last_order_at) as lv,
           s.first_sent, s.last_sent
    from customers c
    join sends s on s.customer_id = c.id
  ),
  wb as (
    select id, name,
      coalesce(
        nullif(last_order_amount, 0),
        case when vis > 0 then round((coalesce(total_spent,0) / vis)::numeric, 2) else 0 end
      ) as value_proxy
    from joined
    where lv is not null
      and lv > first_sent
      and lv <= last_sent + (v_win || ' days')::interval
  )
  select json_build_object(
    'window_days',       v_win,
    'sent_customers',    (select count(*) from sends),
    'won_back',          (select count(*) from wb),
    'recovered_revenue', (select coalesce(round(sum(value_proxy))::int, 0) from wb),
    'rate',              (select case when (select count(*) from sends) > 0
                                   then round(100.0 * (select count(*) from wb) / (select count(*) from sends))::int
                                   else 0 end),
    'names',             (select coalesce(json_agg(name), '[]'::json)
                            from (select name from wb order by value_proxy desc nulls last limit 3) t)
  ) into result;

  return result;
end;
$function$;

-- clicktide_shopify_usage_this_cycle: returns nothing (null) at aal1 when a factor is verified
CREATE OR REPLACE FUNCTION public.clicktide_shopify_usage_this_cycle()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'billed', public.clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start),
    'reported', public.clicktide_shopify_usage_cycle_used(l.user_id, l.cycle_start, true),
    'limit', l.cycle_limit, 'cycle_end', l.cycle_end, 'test_or_dev', l.test_or_dev, 'trialing', l.trialing)
    from public.shopify_usage_limits l where l.user_id = auth.uid() and l.cycle_start is not null
      and public.clicktide_owner_mfa_ok();
$function$;
