-- WP6 / contract C4, step 1 of 2: the 'logos' bucket's upload paths and listing.
-- The bucket stays public, so every object URL already stored (clicktide.logo_url, emails,
-- printed gifts) keeps working: public object URLs are served without RLS. What changes:
--   * uploads only at u/<auth uid>/... (signed in) or anon/... (before signup);
--   * TEMPORARY: logos/... for both roles, the path the live site uses today
--     (index.html uploadLogoToStorage, Design Studio save, text logo, Brand Studio).
--     Remove logos_insert_legacy_path once the new website ships (PLATFORM-SETTINGS.md);
--   * no SELECT policy for anon or authenticated, so nobody can list the bucket.
-- Plain uploads need only an INSERT policy; upserts (x-upsert) would also need SELECT and
-- UPDATE and are refused, which is intended.
-- The type and size limits are step 2 (07_logos_type_size_limits_c4.sql): the live uploader
-- sends SVGs and large PNGs unchecked and drops the logo silently when Storage refuses them,
-- so they wait for WP7's client-side resize. Idempotent: safe to run more than once.

update storage.buckets set public = true where id = 'logos';

-- One statement, new policies first: uploads never run without an INSERT policy.
do $$
begin
  drop policy if exists logos_insert_own_folder on storage.objects;
  create policy logos_insert_own_folder on storage.objects
    for insert to authenticated
    with check (bucket_id = 'logos' and starts_with(name, 'u/' || auth.uid()::text || '/'));

  drop policy if exists logos_insert_anon_folder on storage.objects;
  create policy logos_insert_anon_folder on storage.objects
    for insert to anon
    with check (bucket_id = 'logos' and starts_with(name, 'anon/'));

  drop policy if exists logos_insert_legacy_path on storage.objects;
  create policy logos_insert_legacy_path on storage.objects
    for insert to anon, authenticated
    with check (bucket_id = 'logos' and starts_with(name, 'logos/'));

  drop policy if exists "Anyone can upload logos" on storage.objects;
  drop policy if exists "Anyone can read logos" on storage.objects;
end
$$;
