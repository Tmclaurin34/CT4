-- Verified business-profile change requests (OTP-confirmed) + audit trail for back office.
create table if not exists public.business_profile_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  changes jsonb not null,                -- {field:{from,to}, ...}
  channel text not null check (channel in ('email','sms')),
  sent_to text not null,                 -- masked destination shown to the user
  code_hash text not null,
  attempts int not null default 0,
  status text not null default 'pending' check (status in ('pending','confirmed','expired','cancelled')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists idx_bpc_user_created on public.business_profile_changes(user_id, created_at desc);

alter table public.business_profile_changes enable row level security;

-- Owners see their own change history; staff (admin/support) see all for support.
drop policy if exists bpc_select_own_or_staff on public.business_profile_changes;
create policy bpc_select_own_or_staff on public.business_profile_changes
  for select using (auth.uid() = user_id or clicktide_is_staff(array['admin','support']));

-- No insert/update/delete policies: only the confirm-biz-change edge function
-- (service role) writes here, so codes and statuses can't be forged by clients.

grant execute on function public.clicktide_is_staff(text[]) to authenticated;
