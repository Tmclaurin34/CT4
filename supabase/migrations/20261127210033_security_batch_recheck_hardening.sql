-- Live re-check follow-ups (2026-11-27), all idempotent.
-- N7: retention_category_priors is read-only reference data (only policy: authenticated SELECT).
-- The default grants left anon/authenticated able to write it, held back only by RLS.
revoke insert, update, delete, truncate, references, trigger on table public.retention_category_priors from anon, authenticated;
revoke select on table public.retention_category_priors from anon;
-- N22: foreign keys without a covering index (ON DELETE CASCADE scans).
create index if not exists pos_transactions_seen_customer_id_idx on public.pos_transactions_seen (customer_id);
create index if not exists shopify_install_claims_connection_id_idx on public.shopify_install_claims (connection_id);
