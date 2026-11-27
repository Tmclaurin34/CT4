-- WP5: the campaign engine's per-business state as ONE jsonb value, so it is never cut
-- off by PostgREST's 1,000-row response cap (a scalar is one row). Replaces the
-- unpaged campaign_sends and sms_messages reads in campaign-runner.
-- Idempotent and additive. Apply BEFORE deploying campaign-runner v42 / send-customer-sms.

-- Texts a business has had delivered this calendar month (UTC), the plan-allowance counter.
create or replace function public.clicktide_sms_usage(p_user uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.sms_messages m
   where m.user_id = p_user
     and m.status = 'sent'
     and m.sent_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC');
$$;

-- {
--   "last":     {"<campaign_id>:<customer_id>": <epoch ms of the newest send>},
--                 the cooldown map: last 365 days, address requests excluded, and a
--                 'deferred' (transient provider failure) row only once it is 24h old,
--                 so a deferred touch is retried hourly for a day and then gives up;
--   "touches":  [[customer_id, campaign_id, distinct UTC days touched, epoch ms of newest]],
--                 sends that reached (or were queued for) the customer AFTER their latest
--                 visit or order, however long ago: the input to the three-win-back-touch
--                 limit, which must not wear off for customers lapsed over a year;
--   "triggers": {"<campaign_id>": "<trigger text>"} for every campaign in "touches",
--                 including paused ones, so the engine classifies them itself;
--   "sms_used": this month's delivered texts (clicktide_sms_usage);
--   "texted_recently": [customer_id] texted by this business in the last 30 days
-- }
create or replace function public.clicktide_campaign_state(p_user uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with recent as (
    select s.campaign_id, s.customer_id, s.status, s.sent_at
      from public.campaign_sends s
     where s.user_id = p_user
       and s.sent_at >= now() - interval '365 days'
       and s.channel <> 'address_request'
  ),
  last_send as (
    select r.campaign_id, r.customer_id, max(r.sent_at) as last_at
      from recent r
     where r.status <> 'deferred' or r.sent_at < now() - interval '24 hours'
     group by r.campaign_id, r.customer_id
  ),
  -- No 365-day bound here (campaign_sends_lookup serves the per-business scan); greatest()
  -- ignores nulls, so the newer of the last visit and the last order resets the count.
  touch as (
    select s.customer_id, s.campaign_id,
           count(distinct (s.sent_at at time zone 'UTC')::date) as days,
           max(s.sent_at) as last_at
      from public.campaign_sends s
      join public.customers c on c.id = s.customer_id and c.user_id = p_user
     where s.user_id = p_user
       and s.channel <> 'address_request'
       and s.status in ('sent', 'queued_review', 'unconfirmed')
       and s.sent_at > coalesce(greatest(c.last_visit_at, c.last_order_at), '-infinity'::timestamptz)
     group by s.customer_id, s.campaign_id
  )
  select jsonb_build_object(
    'last', coalesce((
      select jsonb_object_agg(l.campaign_id::text || ':' || l.customer_id::text,
                              floor(extract(epoch from l.last_at) * 1000)::bigint)
        from last_send l), '{}'::jsonb),
    'touches', coalesce((
      select jsonb_agg(jsonb_build_array(t.customer_id, t.campaign_id, t.days,
                                         floor(extract(epoch from t.last_at) * 1000)::bigint))
        from touch t), '[]'::jsonb),
    'triggers', coalesce((
      select jsonb_object_agg(k.id::text, coalesce(k.trigger, ''))
        from public.campaigns k
       where k.user_id = p_user
         and k.id in (select t.campaign_id from touch t)), '{}'::jsonb),
    'sms_used', public.clicktide_sms_usage(p_user),
    'texted_recently', coalesce((
      select jsonb_agg(distinct m.customer_id)
        from public.sms_messages m
       where m.user_id = p_user
         and m.status = 'sent'
         and m.customer_id is not null
         and m.sent_at >= now() - interval '30 days'), '[]'::jsonb)
  );
$$;

-- Both take an arbitrary business id, so only the service role may call them.
revoke all on function public.clicktide_sms_usage(uuid) from public, anon, authenticated;
revoke all on function public.clicktide_campaign_state(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_sms_usage(uuid) to service_role;
grant execute on function public.clicktide_campaign_state(uuid) to service_role;
