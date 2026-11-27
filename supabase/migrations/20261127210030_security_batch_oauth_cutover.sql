-- WP3 / contract C3 — APPLY ONLY AFTER the new website (WP7) is live everywhere, i.e.
-- every Connect button calls oauth-start and every return calls oauth-confirm, AND the
-- edge secret OAUTH_ALLOW_LEGACY_STATES has been set to false.
-- From here on the browser never touches oauth_states; states are created by oauth-start
-- (service role) only. Idempotent.
revoke insert, select on table public.oauth_states from authenticated;
