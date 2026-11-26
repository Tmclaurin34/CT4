-- Reserve Clicktide's own Messaging Service for the platform row only.
-- Replaces the one-active-row-per-service unique index, which would also have
-- blocked two accounts of one legal business (e.g. two locations) from sharing
-- their own registered service, and did nothing if the platform row was absent.
drop index if exists public.a2p_registrations_active_msid_uniq;
alter table public.a2p_registrations
  add constraint a2p_platform_msid_reserved
  check (reg_type = 'platform' or messaging_service_sid is distinct from 'MG4c1badf5712739590510f936bbd0bc1a');
