-- Tighten permissive OAuth state policies.
-- The app keeps unauthenticated OAuth state in sessionStorage; DB rows should be user-scoped.

drop policy if exists "Anyone can delete oauth state" on public.oauth_states;
drop policy if exists "Anyone can insert oauth state" on public.oauth_states;
drop policy if exists "Anyone can read and delete their own state" on public.oauth_states;

alter table public.oauth_states enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'oauth_states'
      and policyname = 'oauth_states_user_all'
  ) then
    create policy oauth_states_user_all on public.oauth_states
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

