-- Applied to production as migration 20261126073413 (sms_messages_append_only).
-- Recovered verbatim from supabase_migrations.schema_migrations.statements on 2026-11-27,
-- so the repo records what the database already ran (branch claude/unruffled-aryabhata-b9b435).

-- Text-message log: server-only writes. sms_messages_user_all (ALL) let any owner
-- INSERT/UPDATE/DELETE their own rows from the browser; campaign-runner counts these
-- rows against the plan's included texts (Growth 1500 / Scale 5000, then $0.05 wallet
-- overage), so deleting rows monthly = unlimited free texts + erased A2P audit trail.
-- No browser code writes this table; edge functions use the service role (bypasses RLS).

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
