-- WP5: indexes for ops-alerts' hourly reads, which today scan whole tables
-- (the only campaign_sends index leads with user_id). Partial, so they stay tiny.
-- Idempotent and additive. The tables are small today, so a plain CREATE INDEX
-- holds its write lock for milliseconds.

create index if not exists campaign_sends_problem_sent_at
  on public.campaign_sends (sent_at)
  where status in ('failed', 'deferred', 'unconfirmed');

create index if not exists sms_messages_failed_created_at
  on public.sms_messages (created_at)
  where status = 'failed';
