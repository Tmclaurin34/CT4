-- Scale guardrails: hot-path indexes for dashboard + campaign engine queries
-- Applied to production 2026-06-12 via MCP (scale_guard_indexes).
create index if not exists idx_customers_user on public.customers using btree (user_id);
create index if not exists idx_customers_user_email on public.customers using btree (user_id, email);
create index if not exists idx_customers_user_phone on public.customers using btree (user_id, phone);
create index if not exists idx_campaigns_user_status on public.campaigns using btree (user_id, status);
create index if not exists idx_wallet_user_created on public.wallet using btree (user_id, created_at desc);
create index if not exists idx_sms_user_status_sent on public.sms_messages using btree (user_id, status, sent_at);
create index if not exists idx_shipments_user on public.shipments using btree (user_id);
create index if not exists idx_alerts_user_resolved on public.alerts using btree (user_id, resolved);

-- Single-order trigger support (applied 2026-06-12 via MCP customers_last_order_amount)
alter table public.customers add column if not exists last_order_amount numeric;

-- Anniversary/tenure trigger support (applied 2026-06-12 via MCP customers_first_order_at)
alter table public.customers add column if not exists first_order_at timestamptz;
update public.customers set first_order_at = coalesce(first_order_at, last_visit_at, created_at) where first_order_at is null;
