-- WP6: "verified" business-profile changes can no longer be skipped with a direct PATCH.
-- Settings > Business contact sends these fields through confirm-biz-change (a code goes to
-- the contact already on file, then the service role applies them). Until now a browser
-- session could PATCH /rest/v1/clicktide with any of them and skip the code.
-- Once a business has been through checkout (any Stripe subscription id or status, including
-- past_due, unpaid, canceled and incomplete), a browser write that changes one of these
-- fields is refused. Before checkout (both columns null), onboarding still edits them
-- directly, and admin/support staff (back office) still can.
-- A separate trigger, so the billing guard (clicktide_guard_protected_columns) is untouched.
-- Idempotent: safe to run more than once.

create or replace function public.clicktide_guard_verified_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;   -- service role (confirm-biz-change, webhooks), pg_cron, SQL editor
  end if;
  if old.stripe_subscription_id is null and old.stripe_subscription_status is null then
    return new;   -- pre-checkout onboarding
  end if;
  if (new.business_name, new.contact_name, new.phone, new.business_phone, new.business_email,
      new.website, new.address, new.city, new.state, new.zip)
     is not distinct from
     (old.business_name, old.contact_name, old.phone, old.business_phone, old.business_email,
      old.website, old.address, old.city, old.state, old.zip) then
    return new;
  end if;
  if public.clicktide_is_staff(array['admin', 'support']) then
    return new;
  end if;
  raise exception 'Business name, contact details and address are verified: change them under Settings > Business contact, which confirms the change with a code.'
    using errcode = '42501';
end;
$$;
revoke all on function public.clicktide_guard_verified_profile() from public, anon, authenticated;

create or replace trigger clicktide_guard_verified_profile
  before update of business_name, contact_name, phone, business_phone, business_email,
                   website, address, city, state, zip
  on public.clicktide
  for each row execute function public.clicktide_guard_verified_profile();
