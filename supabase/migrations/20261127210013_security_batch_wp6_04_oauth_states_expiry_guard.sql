-- WP6: browser-created OAuth states live 10 minutes, pending the C3 cutover.
-- Until the new website ships, the live site still inserts its own oauth_states rows and the
-- callbacks still accept them (C3 transition), with an expires_at the browser chose: one
-- state could stay valid for years. A browser-made state is now pinned to the caller,
-- expires 10 minutes after it is stored and can never claim to be server-created. The
-- service role (oauth-start), pg_cron and the SQL editor are unchanged.
--
-- WP3's 01_wp3_pos_oauth_and_sync.sql installs the same guard under the same names. This
-- file creates them only when they are missing and never replaces WP3's version, so in
-- either apply order exactly one guard exists. Idempotent: safe to run more than once.

revoke all on table public.oauth_states from anon;
revoke update, delete, truncate, references, trigger on table public.oauth_states from authenticated;

do $$
begin
  if to_regprocedure('public.clicktide_oauth_states_browser_guard()') is null then
    create function public.clicktide_oauth_states_browser_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    declare
      v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
      v_role   text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
    begin
      if v_role = 'service_role' then
        return new;
      end if;
      if v_role is null and session_user <> 'authenticator' then
        return new;
      end if;
      new.user_id    := auth.uid();
      new.created_at := now();
      new.expires_at := now() + interval '10 minutes';
      new.metadata   := case when jsonb_typeof(new.metadata) = 'object'
                             then new.metadata - 'server_created'
                             else '{}'::jsonb end;
      return new;
    end;
    $fn$;
    revoke all on function public.clicktide_oauth_states_browser_guard() from public, anon, authenticated;
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.oauth_states'::regclass
                    and tgname = 'clicktide_oauth_states_browser_guard'
                    and not tgisinternal) then
    create trigger clicktide_oauth_states_browser_guard
      before insert or update on public.oauth_states
      for each row execute function public.clicktide_oauth_states_browser_guard();
  end if;
end
$$;
