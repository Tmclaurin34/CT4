-- Clicktide legal acceptance fields.
-- Additive only: safe to run more than once.

alter table public.clicktide
  add column if not exists legal_terms_accepted_at timestamptz,
  add column if not exists legal_terms_version text,
  add column if not exists legal_authorized_services boolean default false;
