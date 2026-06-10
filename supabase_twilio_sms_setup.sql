-- Clicktide SMS/Twilio support.
-- Adds customer SMS consent, campaign delivery channel, and an auditable SMS log.

alter table public.customers
  add column if not exists phone text,
  add column if not exists sms_consent boolean default false,
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_unsubscribed_at timestamptz;

alter table public.campaigns
  add column if not exists delivery_channel text default 'email',
  add column if not exists sms_message text;

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id bigint references public.campaigns(id) on delete set null,
  customer_id bigint references public.customers(id) on delete set null,
  to_phone text not null,
  body text not null,
  status text not null default 'queued',
  provider text not null default 'twilio',
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.sms_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sms_messages'
      and policyname = 'sms_messages_user_all'
  ) then
    create policy sms_messages_user_all on public.sms_messages
      for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if to_regprocedure('public.clicktide_is_staff(text[])') is not null
    and not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'sms_messages'
        and policyname = 'sms_messages_staff_all'
    )
  then
    execute 'create policy sms_messages_staff_all on public.sms_messages
      for all
      using (public.clicktide_is_staff(array[''admin'',''support'',''partner'']))
      with check (public.clicktide_is_staff(array[''admin'',''support'',''partner'']))';
  end if;
end $$;

grant select, insert, update, delete on public.sms_messages to authenticated;
