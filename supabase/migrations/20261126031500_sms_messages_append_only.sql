-- =====================================================================
-- Text-message log: server-only writes (2026-11-26)
--
-- Found while fixing the plan/wallet hole. sms_messages had policy
-- sms_messages_user_all (cmd ALL, auth.uid() = user_id), so any owner could
-- INSERT / UPDATE / DELETE their own rows from the browser. campaign-runner
-- counts this month's rows (status=sent) against the plan's included texts
-- (Growth 1500 / Scale 5000) and charges $0.05 wallet overage beyond that —
-- so deleting your own rows each month = unlimited free texts, and it also
-- erases the SMS audit trail (A2P compliance).
--
-- No browser code writes this table (index.html: zero references; the back
-- office only reads it). Writers are edge functions on the service role,
-- which bypasses RLS. So: owners and staff read, nobody writes through the
-- authenticated API.
--
-- Safe to re-run.
-- =====================================================================

drop policy if exists sms_messages_user_all on public.sms_messages;
drop policy if exists sms_messages_staff_all on public.sms_messages;
drop policy if exists sms_messages_owner_read on public.sms_messages;
drop policy if exists sms_messages_staff_read on public.sms_messages;

create policy sms_messages_owner_read on public.sms_messages
  for select to authenticated
  using (auth.uid() = user_id);

create policy sms_messages_staff_read on public.sms_messages
  for select to authenticated
  using (public.clicktide_can_access_client(user_id));

revoke insert, update, delete, truncate on table public.sms_messages from anon, authenticated;
