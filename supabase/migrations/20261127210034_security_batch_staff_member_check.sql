-- Back office TOTP enrollment (C6): "is the caller an active staff member?" answered for the
-- caller only (auth.uid()), at any aal, so a staff member without an authenticator can be
-- offered setup even after staff_require_mfa is on. Grants no staff powers.
create or replace function public.clicktide_is_staff_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.clicktide_staff s where s.user_id = auth.uid() and s.is_active);
$$;
revoke all on function public.clicktide_is_staff_member() from public, anon;
grant execute on function public.clicktide_is_staff_member() to authenticated, service_role;
