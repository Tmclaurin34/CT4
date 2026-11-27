-- WP6: browser roles (anon, authenticated) keep only the table privileges the live pages use
-- (site/index.html, backoffice.html, free-pos-audit.html; checked call by call). RLS stays the
-- row filter; this takes away the write paths no policy should ever need, and TRUNCATE and
-- MAINTAIN, which RLS does not filter at all. Every edge function writes with the service
-- role, which is untouched.
-- platform_connections is the POS package's (contract C3) and is not listed here.
-- Postgres 17 (MAINTAIN). Idempotent: safe to run more than once.

-- 1. Never needed by an API role, on any table, now or later.
revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

-- 2. anon writes only funnel events (free-pos-audit track()) and Building Check leads.
revoke insert, update, delete on
  public.ai_suggestions, public.alerts, public.brand_products, public.business_profile_changes,
  public.campaign_sends, public.campaigns, public.clicktide, public.clicktide_admin_audit_log,
  public.clicktide_partner_clients, public.clicktide_staff, public.customers,
  public.email_templates, public.gift_catalog, public.message_events, public.oauth_states,
  public.ops_alert_runs, public.ops_alert_status, public.pos_audits, public.printify_products,
  public.shipments, public.sms_messages, public.stripe_webhook_events, public.support_chats,
  public.survey_responses, public.wallet
from anon;
revoke update, delete on public.funnel_events, public.inbound_leads from anon;
grant insert on public.funnel_events, public.inbound_leads to anon;

-- 3. Read and written only by edge functions; no policies exist on them.
revoke all on
  public.ops_alert_runs, public.ops_alert_status, public.printify_products,
  public.stripe_webhook_events, public.support_chats
from anon, authenticated;

-- 4. authenticated: write privileges no live page uses.
revoke insert, update, delete on
  public.brand_products, public.business_profile_changes, public.campaign_sends,
  public.message_events, public.survey_responses, public.shipments, public.inbound_leads
from authenticated;
revoke insert, delete on public.ai_suggestions, public.alerts from authenticated;   -- owners PATCH status only
revoke delete on public.clicktide from authenticated;
revoke update, delete on public.clicktide_admin_audit_log, public.funnel_events, public.oauth_states
from authenticated;

-- 5. Owner-only RPCs: they answer anon with {"error":"unauthorized"}; now anon can't call them.
revoke all on function public.clicktide_customers(integer, text, text, timestamp with time zone, timestamp with time zone, integer, integer)
  from public, anon;
grant execute on function public.clicktide_customers(integer, text, text, timestamp with time zone, timestamp with time zone, integer, integer)
  to authenticated, service_role;
revoke all on function public.clicktide_winback_stats(integer) from public, anon;
grant execute on function public.clicktide_winback_stats(integer) to authenticated, service_role;

-- A trigger function runs without an EXECUTE check; nobody needs to call it directly.
revoke all on function public.clicktide_owner_sms_consent_guard() from public, anon, authenticated;
