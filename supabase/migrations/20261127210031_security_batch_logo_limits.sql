-- WP6 / contract C4, step 2 of 2: the 'logos' bucket accepts only PNG, JPEG, WebP and GIF,
-- at most 3 MiB (no SVG: it can carry script).
-- APPLY ONLY together with or after WP7's apply_frontend_fixes.py (ctLogoFit) is live on
-- goclicktide.com. The live uploaders (onboarding uploadLogoToStorage, Brand Studio, which
-- accepts image/svg+xml) send the file unchecked; onboarding swallows the refusal and never
-- saves logo_url, so gift and postcard orders would print without the business's logo.
-- 3145728 bytes, so a client check of 3 MB or 3 MiB never passes a file the server refuses.
-- Idempotent: safe to run more than once.

update storage.buckets
   set public             = true,
       file_size_limit    = 3145728,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
 where id = 'logos';
