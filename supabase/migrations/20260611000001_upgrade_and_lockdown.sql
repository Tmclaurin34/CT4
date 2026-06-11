-- Upgrade migration for EXISTING Supabase projects + server-RPC lockdown.
-- Complements 20260611000000_full_schema_snapshot.sql (which covers fresh
-- installs via CREATE TABLE IF NOT EXISTS, but cannot add columns to tables
-- that already exist). Idempotent: safe to run repeatedly.
-- Applied to the live project 2026-06-11 (migration lock_server_rpcs +
-- earlier column migrations); kept here so any environment can catch up.

-- ============ NEW COLUMNS ON EXISTING TABLES ============
alter table public.clicktide  add column if not exists gift_auto_send boolean default false;
alter table public.clicktide  add column if not exists google_review_url text;
alter table public.clicktide  add column if not exists dashboard_color text;
alter table public.clicktide  add column if not exists dashboard_bg text;
alter table public.customers  add column if not exists address_request_token uuid default gen_random_uuid();
alter table public.customers  add column if not exists address_requested_at timestamptz;
alter table public.customers  add column if not exists address_confirmed_at timestamptz;
create index if not exists customers_address_request_token_idx on public.customers (address_request_token);

-- ============ BACKFILL ============
update public.customers
set address_request_token = gen_random_uuid()
where address_request_token is null;

-- ============ SERVER-ONLY RPC LOCKDOWN ============
-- These SECURITY DEFINER functions are called exclusively by edge functions
-- using the service role (campaign engine auth key, wallet debits/balance).
-- The frontend references none of them. Without these revokes, functions
-- recreated by the snapshot default to PUBLIC execute.
revoke all on function public.clicktide_internal_key() from public, anon, authenticated;
grant execute on function public.clicktide_internal_key() to service_role;

revoke all on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_debit_gift_wallet_server(uuid, numeric, text, text) to service_role;

revoke all on function public.clicktide_debit_gift_wallet(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.clicktide_debit_gift_wallet(uuid, numeric, text, text) to service_role;

revoke all on function public.clicktide_wallet_balance(uuid) from public, anon, authenticated;
grant execute on function public.clicktide_wallet_balance(uuid) to service_role;
