update public.clicktide_staff set is_active=false where user_id='675f5e6d-2de0-43e3-91f9-8126b5e6967a';
-- WP6 / contract C6: staff powers require an MFA session. APPLY LAST, and only after
--   1. every active clicktide_staff account has a verified TOTP factor (enroll in the app:
--      Settings > Two-step verification), and
--   2. the back office signs in with the MFA challenge (WP7). The live back office signs in
--      with a password only, so it stops loading clients until that ships.
-- From then on clicktide_is_staff, clicktide_can_access_client (staff/partner branches),
-- clicktide_can_manage_fulfillment and clicktide_staff_can_write answer false for staff
-- unless auth.jwt()->>'aal' = 'aal2'. Everything built on them follows: the *_staff_*
-- policies, wallet_staff_insert, the billing guard's staff bypass, staff analytics.
-- An owner acting on their own rows (auth.uid() = user_id) is unaffected.
-- Break-glass (lost authenticator): PLATFORM-SETTINGS.md, "Staff MFA".
-- Idempotent: safe to run more than once.

do $$
declare
  v_missing integer;
begin
  if to_regprocedure('public.clicktide_staff_session_ok()') is null
     or to_regclass('public.clicktide_security_flags') is null then
    raise exception 'Apply 03_staff_helpers_partner_scope.sql before this file';
  end if;

  begin
    select count(*) into v_missing
      from public.clicktide_staff s
     where s.is_active
       and not exists (select 1
                         from auth.mfa_factors f
                        where f.user_id = s.user_id
                          and f.status = 'verified');
  exception
    when insufficient_privilege then
      raise exception 'Cannot read auth.mfa_factors to check staff MFA. Confirm every active staff account has a verified factor (Dashboard > Authentication > Users), then run only the INSERT at the end of this file.';
  end;

  if v_missing > 0 then
    raise exception '% active staff account(s) have no verified MFA factor yet; enroll TOTP first', v_missing;
  end if;
end
$$;

insert into public.clicktide_security_flags (flag, enabled, note)
values ('staff_require_mfa', true, 'C6: staff powers need an aal2 (MFA) session')
on conflict (flag) do update
   set enabled = excluded.enabled, note = excluded.note, updated_at = now();
