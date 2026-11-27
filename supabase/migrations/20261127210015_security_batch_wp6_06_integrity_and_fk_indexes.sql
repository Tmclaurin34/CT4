-- WP6: one business row per owner, and indexes for the hot tenant key and unindexed
-- foreign keys (Supabase advisor). The ops-alerts and resend-webhook lookup indexes are
-- added by WP5 (03_ops_alerts_indexes.sql) and WP4 (02_wp4_resend_webhook_lookup_index.sql).
-- The tables are small today, so plain CREATE INDEX holds its lock for milliseconds; on a
-- large table build them CONCURRENTLY, outside a transaction. Idempotent.

-- 1. clicktide.user_id is the tenant key every policy, trigger and engine looks up, and it
--    had no index. Unique: a double-submitted signup can no longer create a second row
--    (which made enforce_customer_cap's LIMIT 1 and campaign-runner's bizByUser pick an
--    arbitrary one). NULL demo rows stay allowed. A plain unique index (not partial), so
--    PostgREST upserts can use on_conflict=user_id.
do $$
declare
  v_attnum smallint;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.clicktide'::regclass and a.attname = 'user_id' and not a.attisdropped;

  if not exists (select 1 from pg_index i
                  where i.indrelid = 'public.clicktide'::regclass
                    and i.indisunique
                    and i.indnkeyatts = 1
                    and i.indkey[0] = v_attnum
                    and i.indpred is null) then
    if exists (select 1 from public.clicktide
                where user_id is not null
                group by user_id having count(*) > 1) then
      raise exception 'public.clicktide has several rows for one user_id; merge them, then re-run this file';
    end if;
    create unique index clicktide_user_id_key on public.clicktide (user_id);
  end if;
end
$$;

-- 2. Foreign keys without a covering index: every customer delete scanned campaign_sends
--    (ON DELETE CASCADE) and sms_messages (ON DELETE SET NULL) once per deleted row.
create index if not exists campaign_sends_customer_id_idx on public.campaign_sends (customer_id);
create index if not exists campaign_sends_campaign_id_idx on public.campaign_sends (campaign_id);
create index if not exists sms_messages_customer_id_idx on public.sms_messages (customer_id);
create index if not exists sms_messages_campaign_id_idx on public.sms_messages (campaign_id);
create index if not exists campaigns_gift_catalog_id_idx on public.campaigns (gift_catalog_id);
create index if not exists oauth_states_user_id_idx on public.oauth_states (user_id);
create index if not exists shipments_merchant_id_idx on public.shipments (merchant_id);
create index if not exists clicktide_admin_audit_log_actor_idx on public.clicktide_admin_audit_log (actor_user_id);
create index if not exists clicktide_admin_audit_log_client_idx on public.clicktide_admin_audit_log (client_user_id);
create index if not exists clicktide_partner_clients_client_idx on public.clicktide_partner_clients (client_user_id);
