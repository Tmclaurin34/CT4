-- WP4 (email): resend-webhook attributes every Resend event with
--   campaign_sends?channel=eq.email&detail=eq.<resend email id>
-- which had no usable index (campaign_sends_lookup leads with user_id).
-- Idempotent and additive. campaign_sends is small today, so a plain (non-concurrent)
-- build is instant; on a large table build it CONCURRENTLY outside a transaction.
create index if not exists campaign_sends_email_detail_idx
  on public.campaign_sends (detail)
  where channel = 'email';
