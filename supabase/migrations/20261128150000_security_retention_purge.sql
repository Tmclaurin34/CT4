-- Never queue behind a busy table while deploying: fail fast instead (re-run later; the file is idempotent).
set lock_timeout = '5s';

-- Security data retention (package "data", 2026-11-27, revised 2026-11-27 with owner decisions)
-- Repo file: supabase/migrations/20261128130000_security_retention_purge.sql
--
-- Adds a SEPARATE nightly purge for security-sensitive data. It does not touch
-- public.clicktide_retention_purge() (migration 20261127160000_data_retention.sql),
-- which keeps handling closed businesses, 2-year sms deletion, oauth_states,
-- funnel_events and pos_transactions_seen.
--
-- Windows (conservative):
--   message_events.raw          -> NULL after 180 days (row kept: campaign stats use event_type)
--   sms_messages body/to_phone  -> redacted after 365 days (row kept: SMS billing counts it)
--   owner_sms_log body of kind 'bizchange_code' (the owner's one-time confirmation code text
--                                  from confirm-biz-change) -> redacted after 1 day (row kept:
--                                  the per-account / per-number daily send caps count rows)
--   support_chats               -> deleted after 365 days
--   cron.job_run_details        -> deleted after 30 days
--   business_profile_changes    -> after 90 days:
--                                  * 'confirmed' rows are KEPT (back-office change history: who,
--                                    what, when); only code_hash and sent_to are scrubbed
--                                  * 'pending' / 'expired' / 'cancelled' rows are deleted
--                                    (a pending code is dead after 15 minutes)
--   message_events of customers that no longer exist -> detached (customer_id NULL) + raw NULL.
--     Nightly this only looks at rows created in the last 45 days (a safety net: the delete
--     trigger below handles new deletions). The existing backlog is cleared once, at the end
--     of this file.
--
-- Customer deletion: a BEFORE DELETE trigger on public.customers redacts that customer's
-- sms_messages (the FK is ON DELETE SET NULL, so the row and its billing count survive,
-- but the body/phone would otherwise stay forever) and detaches+redacts their
-- message_events (no FK at all, so they were simply left behind).
--
-- Every statement below is idempotent (create or replace / if not exists / drop-if-exists,
-- and the one-time backlog UPDATE matches nothing on a second run).
-- Each nightly purge step works on at most p_batch rows per run so a run is always short.

-- ---------------------------------------------------------------------------
-- 1. Indexes so the batched purges and the delete trigger never scan whole tables.
-- ---------------------------------------------------------------------------
create index if not exists message_events_customer_id_idx
  on public.message_events (customer_id) where customer_id is not null;

create index if not exists message_events_attached_created_idx
  on public.message_events (created_at) where customer_id is not null;

create index if not exists message_events_raw_created_idx
  on public.message_events (created_at) where raw is not null;

create index if not exists sms_messages_unredacted_created_idx
  on public.sms_messages (created_at) where to_phone <> 'redacted';

create index if not exists support_chats_created_at_idx
  on public.support_chats (created_at);

-- owner_sms_log already has owner_sms_log_created (created_at desc); business_profile_changes
-- is a handful of rows per business, so neither needs a new index.

-- ---------------------------------------------------------------------------
-- 2. The purge function.
--    p_dry_run = true or NULL (the default) -> counts only, changes nothing.
--    p_dry_run = false                       -> the real run (the cron job passes false).
--    p_batch           -> max rows touched per step per run (clamped 1..50000).
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_security_retention_purge(
  p_dry_run boolean default true,
  p_batch integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  dry  constant boolean := coalesce(p_dry_run, true);   -- a NULL never causes a real run
  lim  constant integer := least(greatest(coalesce(p_batch, 5000), 1), 50000);
  res  jsonb;
  errs jsonb := '{}'::jsonb;
  n    bigint;
  phone_re constant text := '\+?\d[\d\s().-]{6,}\d';
begin
  res := jsonb_build_object('dry_run', dry, 'batch', lim);

  -- 2a. message_events.raw (provider webhook payloads: recipient email, subject, headers)
  begin
    if dry then
      select count(*) into n from public.message_events
       where raw is not null and created_at < now() - interval '180 days';
    else
      update public.message_events e set raw = null
       where e.id in (select m.id from public.message_events m
                       where m.raw is not null and m.created_at < now() - interval '180 days'
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('message_events_raw_cleared', n);
  exception when others then errs := errs || jsonb_build_object('message_events_raw_cleared', sqlerrm);
  end;

  -- 2b. message_events still pointing at a customer that no longer exists.
  --     Bounded to the last 45 days: older orphans were cleared once by this migration, and
  --     the delete trigger keeps new ones from appearing, so this is only a safety net
  --     (e.g. deletes made with triggers disabled).
  begin
    if dry then
      select count(*) into n from public.message_events m
       where m.customer_id is not null
         and m.created_at >= now() - interval '45 days'
         and not exists (select 1 from public.customers c where c.id = m.customer_id);
    else
      update public.message_events e set customer_id = null, raw = null
       where e.id in (select m.id from public.message_events m
                       where m.customer_id is not null
                         and m.created_at >= now() - interval '45 days'
                         and not exists (select 1 from public.customers c where c.id = m.customer_id)
                       limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('message_events_orphans_detached', n);
  exception when others then errs := errs || jsonb_build_object('message_events_orphans_detached', sqlerrm);
  end;

  -- 2c. sms_messages: keep the row (billing / usage counts), drop the content.
  begin
    if dry then
      select count(*) into n from public.sms_messages
       where to_phone <> 'redacted' and created_at < now() - interval '365 days';
    else
      update public.sms_messages s
         set to_phone = 'redacted',
             body = '[redacted]',
             error = case when s.error is null then null
                          else regexp_replace(s.error, phone_re, '[redacted]', 'g') end
       where s.id in (select m.id from public.sms_messages m
                       where m.to_phone <> 'redacted' and m.created_at < now() - interval '365 days'
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('sms_messages_redacted', n);
  exception when others then errs := errs || jsonb_build_object('sms_messages_redacted', sqlerrm);
  end;

  -- 2d. owner_sms_log: the owner's one-time code texts (confirm-biz-change claims them with
  --     kind 'bizchange_code'; the body contains the 6-digit code). Codes expire after
  --     15 minutes, so after 1 day only the body goes. The row stays: the daily caps in
  --     clicktide_owner_sms_claim count rows, and nothing reads body back.
  begin
    if dry then
      select count(*) into n from public.owner_sms_log
       where kind = 'bizchange_code' and body is not null and body <> '[redacted]'
         and created_at < now() - interval '1 day';
    else
      update public.owner_sms_log o set body = '[redacted]'
       where o.id in (select m.id from public.owner_sms_log m
                       where m.kind = 'bizchange_code' and m.body is not null and m.body <> '[redacted]'
                         and m.created_at < now() - interval '1 day'
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('owner_code_texts_redacted', n);
  exception when others then errs := errs || jsonb_build_object('owner_code_texts_redacted', sqlerrm);
  end;

  -- 2e. support_chats (Maya transcripts)
  begin
    if dry then
      select count(*) into n from public.support_chats
       where created_at < now() - interval '365 days';
    else
      delete from public.support_chats c
       where c.id in (select m.id from public.support_chats m
                       where m.created_at < now() - interval '365 days'
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('support_chats_deleted', n);
  exception when others then errs := errs || jsonb_build_object('support_chats_deleted', sqlerrm);
  end;

  -- 2f. business_profile_changes, confirmed: the back office's change history. Keep the row
  --     (who = user_id, what = changes/channel, when = created_at/confirmed_at); scrub the
  --     code hash and the masked destination the code went to. Both columns are NOT NULL.
  begin
    if dry then
      select count(*) into n from public.business_profile_changes
       where status = 'confirmed' and created_at < now() - interval '90 days'
         and (code_hash <> 'redacted' or sent_to <> 'redacted');
    else
      update public.business_profile_changes b
         set code_hash = 'redacted', sent_to = 'redacted'
       where b.id in (select m.id from public.business_profile_changes m
                       where m.status = 'confirmed' and m.created_at < now() - interval '90 days'
                         and (m.code_hash <> 'redacted' or m.sent_to <> 'redacted')
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('business_profile_changes_scrubbed', n);
  exception when others then errs := errs || jsonb_build_object('business_profile_changes_scrubbed', sqlerrm);
  end;

  -- 2g. business_profile_changes that never took effect (pending / expired / cancelled):
  --     deleted after 90 days. 'pending' rows this old are dead: codes expire after 15 minutes.
  begin
    if dry then
      select count(*) into n from public.business_profile_changes
       where status in ('expired', 'cancelled', 'pending')
         and created_at < now() - interval '90 days';
    else
      delete from public.business_profile_changes b
       where b.id in (select m.id from public.business_profile_changes m
                       where m.status in ('expired', 'cancelled', 'pending')
                         and m.created_at < now() - interval '90 days'
                       order by m.created_at limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('business_profile_changes_deleted', n);
  exception when others then errs := errs || jsonb_build_object('business_profile_changes_deleted', sqlerrm);
  end;

  -- 2h. cron.job_run_details (pg_cron run log; postgres has DELETE on it)
  begin
    if dry then
      select count(*) into n from cron.job_run_details
       where start_time < now() - interval '30 days';
    else
      delete from cron.job_run_details d
       where d.runid in (select r.runid from cron.job_run_details r
                          where r.start_time < now() - interval '30 days'
                          order by r.start_time limit lim);
      get diagnostics n = row_count;
    end if;
    res := res || jsonb_build_object('cron_job_run_details_deleted', n);
  exception when others then errs := errs || jsonb_build_object('cron_job_run_details_deleted', sqlerrm);
  end;

  if errs <> '{}'::jsonb then
    res := res || jsonb_build_object('errors', errs);
    raise warning 'clicktide_security_retention_purge: % step(s) failed: %', (select count(*) from jsonb_object_keys(errs)), errs;
  end if;
  return res;
end
$fn$;

revoke all on function public.clicktide_security_retention_purge(boolean, integer) from public;
revoke all on function public.clicktide_security_retention_purge(boolean, integer) from anon, authenticated;
grant execute on function public.clicktide_security_retention_purge(boolean, integer) to service_role;

comment on function public.clicktide_security_retention_purge(boolean, integer) is
  'Nightly security retention (cron clicktide-security-retention passes false): message_events.raw 180d, sms body/phone 365d (rows kept), owner code-text body 1d (rows kept), support_chats 365d, business_profile_changes 90d (confirmed: code_hash/sent_to scrubbed, row kept; others deleted), cron.job_run_details 30d, orphaned message_events of the last 45d. Called with no argument or NULL it is a DRY RUN (counts only); only an explicit false changes data.';

-- ---------------------------------------------------------------------------
-- 3. When a customer is deleted, scrub what they leave behind.
--    BEFORE DELETE: the sms_messages FK (ON DELETE SET NULL) fires after the row is gone,
--    so this is the last moment the rows can still be found by customer_id.
-- ---------------------------------------------------------------------------
create or replace function public.clicktide_customer_delete_redact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.sms_messages s
     set to_phone = 'redacted',
         body = '[redacted]',
         error = case when s.error is null then null
                      else regexp_replace(s.error, '\+?\d[\d\s().-]{6,}\d', '[redacted]', 'g') end
   where s.customer_id = old.id
     and (s.to_phone <> 'redacted' or s.body <> '[redacted]');

  update public.message_events e
     set customer_id = null, raw = null
   where e.customer_id = old.id;

  return old;
end
$fn$;

revoke all on function public.clicktide_customer_delete_redact() from public;
revoke all on function public.clicktide_customer_delete_redact() from anon, authenticated, service_role;

drop trigger if exists customers_delete_redact on public.customers;
create trigger customers_delete_redact
  before delete on public.customers
  for each row execute function public.clicktide_customer_delete_redact();

-- ---------------------------------------------------------------------------
-- 4. One-time backlog: message_events left behind by customers deleted before the trigger
--    existed (production had 161 on 2026-11-27, all older than 45 days, so the bounded
--    nightly scan would never reach them). One UPDATE, no batching needed at this size.
--    Idempotent: a second run matches nothing.
-- ---------------------------------------------------------------------------
update public.message_events m
   set customer_id = null, raw = null
 where m.customer_id is not null
   and not exists (select 1 from public.customers c where c.id = m.customer_id);

-- Back to the session default so nothing after this file inherits the 5s deploy lock timeout.
reset lock_timeout;
