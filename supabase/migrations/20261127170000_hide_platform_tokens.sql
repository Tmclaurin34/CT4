-- POS / Shopify access tokens are server-only: browser roles can no longer read
-- access_token / refresh_token (edge functions use the service role). Column-level
-- grants: a NEW column on platform_connections must be granted here to be readable.
revoke select on public.platform_connections from anon, authenticated;
grant select (id, user_id, platform, merchant_id, merchant_name, shop_domain, token_expires_at, scope, raw_response, connected_at, updated_at, is_active, last_synced_at) on public.platform_connections to authenticated;
