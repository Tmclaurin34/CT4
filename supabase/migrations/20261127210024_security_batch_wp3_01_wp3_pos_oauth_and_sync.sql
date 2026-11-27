-- WP3 / contract C3: server-bound POS OAuth, platform_connections lockdown, and a
-- replay-safe POS sync.
-- Idempotent and additive: safe to apply more than once. Apply BEFORE deploying the
-- WP3 builds of oauth-start, oauth-confirm, the four *-oauth-callback functions,
-- platform-sync and mindbody-activate-site (they call the RPCs defined here).
--
-- Runs AFTER 18_wp4_01_wp4_email_suppressions.sql (contract C2: clicktide_email_norm,
-- clicktide_email_optout) and after the retention engine (20261127090000: visit history,
-- clicktide_record_visit, pos_transactions_seen), both of which clicktide_pos_apply_orders
-- calls. plpgsql resolves those only at run time, so check for them here and stop early.
do $$
begin
  if to_regprocedure('public.clicktide_email_norm(text)') is null
     or to_regprocedure('public.clicktide_email_optout(uuid,text,text)') is null then
    raise exception 'WP3 01 needs WP4 01 (clicktide_email_norm / clicktide_email_optout) applied first';
  end if;
  if to_regprocedure('public.clicktide_record_visit(uuid,bigint,timestamptz,numeric,text,text)') is null
     or to_regclass('public.pos_transactions_seen') is null then
    raise exception 'WP3 01 needs the retention engine migration (clicktide_record_visit, pos_transactions_seen) applied first';
  end if;
end
$$;

-- 1. oauth_pending: provider tokens waiting for the signed-in owner to confirm (C3).
create table if not exists public.oauth_pending (
  nonce text primary key,
  user_id uuid not null,
  platform text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);
create index if not exists oauth_pending_expires_idx on public.oauth_pending (expires_at);
alter table public.oauth_pending enable row level security;
-- Service role only. No policies on purpose; TRUNCATE ignores RLS, so the grants go too.
revoke all on table public.oauth_pending from public, anon, authenticated;
grant select, insert, update, delete on table public.oauth_pending to service_role;

-- 2. platform_connections: server-side sync state.
--    created_at: when the row was first made (connected_at is reset by some legacy paths).
--    sync_backfill_done_at: when the first import's full-year history finished; null while
--    it is still running. last_synced_at already moves once the most recent 30 days are in.
alter table public.platform_connections
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists sync_backfill_done_at timestamptz,
  add column if not exists sync_status text,
  add column if not exists sync_error text,
  add column if not exists sync_error_at timestamptz,
  add column if not exists sync_fail_count integer not null default 0,
  add column if not exists sync_next_at timestamptz,
  add column if not exists sync_cursor jsonb,
  add column if not exists sync_claimed_until timestamptz,
  add column if not exists sync_claim_holder text,
  add column if not exists disconnected_at timestamptz,
  add column if not exists revoked_at timestamptz;

create index if not exists platform_connections_due_idx
  on public.platform_connections (sync_next_at) where is_active;

-- One POS / Stripe account feeds at most one Clicktide business at a time. Built only
-- when no duplicates exist (there are none today); otherwise it says so and skips.
do $$
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'platform_connections_active_merchant_uq') then
    if exists (select 1 from public.platform_connections
                where is_active and merchant_id <> ''
                group by platform, merchant_id having count(*) > 1) then
      raise notice 'platform_connections_active_merchant_uq NOT created: duplicate active (platform, merchant_id) rows exist';
    else
      create unique index platform_connections_active_merchant_uq
        on public.platform_connections (platform, merchant_id) where is_active and merchant_id <> '';
    end if;
  end if;
end;
$$;

-- 3. Browser access to platform_connections (C3): read the non-secret columns, switch
--    a connection off, nothing else. Tokens, raw_response and the sync internals are
--    server-only, so a stolen session can't walk away with POS credentials, and a
--    tenant can no longer write merchant_id / shop_domain (the Stripe confused deputy).
revoke all on table public.platform_connections from public, anon;
revoke select, insert, update, delete, truncate, references, trigger
  on table public.platform_connections from authenticated;
grant select (id, user_id, platform, merchant_id, merchant_name, shop_domain, scope,
              token_expires_at, connected_at, updated_at, is_active, last_synced_at,
              created_at, sync_status, sync_error, sync_error_at, disconnected_at,
              sync_backfill_done_at)
  on public.platform_connections to authenticated;
grant update (is_active) on public.platform_connections to authenticated;
grant select, insert, update, delete on table public.platform_connections to service_role;

-- A browser UPDATE may only touch the caller's own rows and only end inactive. This
-- also stops a staff session's unfiltered Disconnect from switching off every tenant.
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'platform_connections'
                    and policyname = 'platform_connections_browser_disable_only') then
    create policy platform_connections_browser_disable_only on public.platform_connections
      as restrictive for update to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id and is_active = false);
  end if;
end;
$$;

-- Stamps a browser Disconnect so platform-sync can revoke the grant at the provider
-- and wipe the stored tokens.
create or replace function public.clicktide_platform_connections_browser_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role   text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
begin
  if v_role = 'service_role' then
    return new;
  end if;
  if v_role is null and session_user <> 'authenticator' then
    return new;                                   -- SQL editor, migrations, pg_cron
  end if;
  if old.is_active and not new.is_active then
    new.updated_at := now();
    new.disconnected_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.clicktide_platform_connections_browser_guard() from public, anon, authenticated;

create or replace trigger clicktide_platform_connections_browser_guard
  before update on public.platform_connections
  for each row execute function public.clicktide_platform_connections_browser_guard();

-- 4. oauth_states. The live site still inserts its own states until the new website
--    ships (C3 transition), so INSERT/SELECT stay; nothing else is needed by a browser.
--    A browser-made state is pinned to the caller, lives 10 minutes from now, and can
--    never claim to be server-created.
revoke all on table public.oauth_states from public, anon;
revoke update, delete, truncate, references, trigger on table public.oauth_states from authenticated;
grant select, insert, update, delete on table public.oauth_states to service_role;

create or replace function public.clicktide_oauth_states_browser_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role   text  := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims ->> 'role');
begin
  if v_role = 'service_role' then
    return new;                                   -- oauth-start
  end if;
  if v_role is null and session_user <> 'authenticator' then
    return new;                                   -- SQL editor, migrations, pg_cron
  end if;
  new.user_id    := auth.uid();
  new.created_at := now();
  new.expires_at := now() + interval '10 minutes';
  new.metadata   := case when jsonb_typeof(new.metadata) = 'object'
                         then new.metadata - 'server_created'
                         else '{}'::jsonb end;
  return new;
end;
$$;
revoke all on function public.clicktide_oauth_states_browser_guard() from public, anon, authenticated;

create or replace trigger clicktide_oauth_states_browser_guard
  before insert or update on public.oauth_states
  for each row execute function public.clicktide_oauth_states_browser_guard();

-- 5. pos_audits: the free-audit page only reads its own rows.
revoke all on table public.pos_audits from public, anon;
revoke insert, update, delete, truncate, references, trigger on table public.pos_audits from authenticated;

-- 6. pos_order_ledger: every provider order applied to customers, once.
create table if not exists public.pos_order_ledger (
  connection_id uuid not null references public.platform_connections (id) on delete cascade,
  order_id text not null,
  user_id uuid not null,
  amount numeric,
  ordered_at timestamptz,
  applied_at timestamptz not null default now(),
  primary key (connection_id, order_id)
);
create index if not exists pos_order_ledger_user_idx on public.pos_order_ledger (user_id);
create index if not exists pos_order_ledger_ordered_idx on public.pos_order_ledger (ordered_at);
alter table public.pos_order_ledger enable row level security;
revoke all on table public.pos_order_ledger from public, anon, authenticated;
grant select, insert, update, delete on table public.pos_order_ledger to service_role;

-- 7. RPCs (service role only).

-- Save a connection that a provider callback just proved (legacy direct save, or
-- oauth-confirm). Refuses a merchant that is active under another business.
-- p_fields: merchant_id, merchant_name, shop_domain, access_token, refresh_token,
-- token_expires_at, scope, raw_response.
create or replace function public.clicktide_platform_connection_save(p_user uuid, p_platform text, p_fields jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_merchant text := nullif(btrim(coalesce(p_fields ->> 'merchant_id', '')), '');
  v_id       uuid;
begin
  if p_user is null or v_merchant is null
     or coalesce(p_platform, '') not in ('square', 'shopify', 'clover', 'stripe', 'mindbody') then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtext('pos-merchant:' || p_platform || ':' || v_merchant));

  if exists (select 1 from public.platform_connections pc
              where pc.platform = p_platform and pc.merchant_id = v_merchant
                and pc.is_active and pc.user_id is distinct from p_user) then
    return jsonb_build_object('ok', false, 'reason', 'merchant_in_use');
  end if;

  -- Only this merchant's own row is reused. Switching to a different merchant adds a new
  -- row, and the old one is deactivated below with disconnected_at set, so platform-sync
  -- revokes the old merchant's grant and wipes its tokens instead of overwriting them.
  select pc.id into v_id
    from public.platform_connections pc
   where pc.user_id = p_user and pc.platform = p_platform and pc.merchant_id = v_merchant
   limit 1
   for update;

  if v_id is null then
    insert into public.platform_connections
      (user_id, platform, merchant_id, merchant_name, shop_domain, access_token, refresh_token,
       token_expires_at, scope, raw_response, is_active, connected_at, updated_at, sync_next_at)
    values
      (p_user, p_platform, v_merchant, p_fields ->> 'merchant_name', p_fields ->> 'shop_domain',
       coalesce(p_fields ->> 'access_token', ''), p_fields ->> 'refresh_token',
       (p_fields ->> 'token_expires_at')::timestamptz, p_fields ->> 'scope',
       coalesce(p_fields -> 'raw_response', '{}'::jsonb), true, now(), now(), now())
    returning id into v_id;
  else
    update public.platform_connections pc set
      merchant_id        = v_merchant,
      merchant_name      = p_fields ->> 'merchant_name',
      shop_domain        = p_fields ->> 'shop_domain',
      access_token       = coalesce(p_fields ->> 'access_token', ''),
      refresh_token      = p_fields ->> 'refresh_token',
      token_expires_at   = (p_fields ->> 'token_expires_at')::timestamptz,
      scope              = p_fields ->> 'scope',
      raw_response       = coalesce(p_fields -> 'raw_response', '{}'::jsonb),
      is_active          = true,
      updated_at         = now(),
      disconnected_at    = null,
      revoked_at         = null,
      sync_status        = null,
      sync_error         = null,
      sync_error_at      = null,
      sync_fail_count    = 0,
      sync_next_at       = now(),
      sync_claimed_until = null,
      sync_claim_holder  = null
      -- last_synced_at, sync_cursor and the ledger are kept: a reconnect of the same
      -- merchant re-reads from the last completed pass and skips orders already applied.
    where pc.id = v_id;
  end if;

  -- One live connection per platform per business, as the dashboard shows it; a replaced
  -- one is stamped so platform-sync ends its grant at the provider.
  update public.platform_connections pc
     set is_active = false, disconnected_at = now(), updated_at = now()
   where pc.user_id = p_user and pc.platform = p_platform and pc.id <> v_id and pc.is_active;

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'merchant_in_use');
end;
$$;
revoke all on function public.clicktide_platform_connection_save(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.clicktide_platform_connection_save(uuid, text, jsonb) to service_role;

-- Claim one connection for one sync run (cron, dashboard kick and retries can't overlap).
create or replace function public.clicktide_pos_claim(p_connection uuid, p_holder text, p_seconds integer)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with claimed as (
    update public.platform_connections pc
       set sync_claimed_until = now() + make_interval(secs => greatest(30, least(coalesce(p_seconds, 180), 1800))),
           sync_claim_holder  = p_holder
     where pc.id = p_connection
       and pc.is_active
       and p_holder is not null
       and (pc.sync_claimed_until is null or pc.sync_claimed_until < now() or pc.sync_claim_holder = p_holder)
    returning 1
  )
  select exists (select 1 from claimed);
$$;
revoke all on function public.clicktide_pos_claim(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.clicktide_pos_claim(uuid, text, integer) to service_role;

-- Apply one page of provider orders to the connection's business. An order id already
-- in pos_order_ledger is skipped, so a page can be applied any number of times and the
-- visits / total_spent move once. An order the retention engine's visit ledger already
-- counted (pos_transactions_seen, written by the pre-WP3 sync) is a duplicate too.
-- Matching: same address (public.clicktide_email_norm, contract C2) or same phone (exact,
-- or the stored number ending in the same 10 digits); the oldest matching row wins.
-- Every applied, non-void order is also written to the retention engine's visit history
-- (public.clicktide_record_visit, source = the connection's platform); a failure there
-- never fails the order.
-- A POS email opt-out goes through public.clicktide_email_optout(user, email, 'pos')
-- (contract C2: suppression row with the upgrade rule, and every customer row with that
-- address flagged); nothing here clears an opt-out.
-- p_orders: [{id, email, phone, name, amount, at, address, city, state, zip, email_opt_out, void}]
create or replace function public.clicktide_pos_apply_orders(p_connection uuid, p_orders jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_user      uuid;
  v_platform  text;
  v_o         jsonb;
  v_id        text;
  v_email     text;
  v_phone     text;
  v_last10    text;
  v_name      text;
  v_amount    numeric;
  v_at        timestamptz;
  v_addr      text;
  v_city      text;
  v_state     text;
  v_zip       text;
  v_full      boolean;
  v_opt       boolean;
  v_void      boolean;
  v_cid       bigint;
  v_cid_email text;
  v_had_addr  boolean;
  v_take      boolean;
  v_active    boolean;
  v_n         integer;
  n_applied   integer := 0;
  n_dup       integer := 0;
  n_upd       integer := 0;
  n_new       integer := 0;
  n_cap       integer := 0;
  n_fail      integer := 0;
  n_addr      integer := 0;
  n_opt       integer := 0;
  n_visit     integer := 0;
begin
  select pc.user_id, pc.is_active, pc.platform into v_user, v_active, v_platform
    from public.platform_connections pc where pc.id = p_connection;
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_connection');
  end if;
  if not v_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');   -- disconnected mid-run
  end if;
  if jsonb_typeof(p_orders) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_orders');
  end if;

  -- One batch per business at a time, so two runs can't both create the same new customer.
  perform pg_advisory_xact_lock(hashtext('pos-apply:' || v_user::text));

  for v_o in select e.value from jsonb_array_elements(p_orders) as e(value) loop
    begin
      v_cid       := null;
      v_cid_email := null;
      v_id    := left(nullif(btrim(coalesce(v_o ->> 'id', '')), ''), 200);
      v_email := nullif(public.clicktide_email_norm(v_o ->> 'email'), '');
      v_phone := nullif(btrim(coalesce(v_o ->> 'phone', '')), '');
      v_at    := (v_o ->> 'at')::timestamptz;
      if v_id is null or v_at is null or (v_email is null and v_phone is null) then
        n_fail := n_fail + 1;
        continue;
      end if;
      v_last10 := case when v_phone is null then null else right(regexp_replace(v_phone, '\D', '', 'g'), 10) end;
      v_name   := nullif(btrim(coalesce(v_o ->> 'name', '')), '');
      v_amount := coalesce((v_o ->> 'amount')::numeric, 0);
      v_addr   := nullif(btrim(coalesce(v_o ->> 'address', '')), '');
      v_city   := nullif(btrim(coalesce(v_o ->> 'city', '')), '');
      v_state  := nullif(btrim(coalesce(v_o ->> 'state', '')), '');
      v_zip    := nullif(btrim(coalesce(v_o ->> 'zip', '')), '');
      v_full   := v_addr is not null and v_city is not null and v_state is not null and v_zip is not null;
      v_opt    := coalesce((v_o ->> 'email_opt_out')::boolean, false);
      v_void   := coalesce((v_o ->> 'void')::boolean, false);

      insert into public.pos_order_ledger (connection_id, order_id, user_id, amount, ordered_at)
      values (p_connection, v_id, v_user, v_amount, v_at)
      on conflict (connection_id, order_id) do nothing;
      -- Already counted: by this ledger, or by the earlier sync through the retention
      -- engine's seen-list (same business, platform and provider order id).
      if not found or exists (
        select 1 from public.pos_transactions_seen t
         where t.user_id = v_user and t.source = v_platform and t.source_txn_id = v_id
      ) then
        n_dup := n_dup + 1;
        -- The visit was counted already, but an opt-out made in the POS since then still
        -- arrives on a re-read of the order. Idempotent; nothing clears it.
        if v_opt and v_email is not null then
          if public.clicktide_email_optout(v_user, v_email, 'pos') > 0 then n_opt := n_opt + 1; end if;
        end if;
        continue;
      end if;

      select c.id,
             (coalesce(c.address, '') <> '' and coalesce(c.city, '') <> ''
              and coalesce(c.state, '') <> '' and coalesce(c.zip, '') <> ''),
             nullif(public.clicktide_email_norm(c.email), '')
        into v_cid, v_had_addr, v_cid_email
        from public.customers c
       where c.user_id = v_user
         and ((v_email is not null and public.clicktide_email_norm(c.email) = v_email)
           or (v_phone is not null and (c.phone = v_phone
                                        or (length(v_last10) = 10 and c.phone like ('%' || v_last10)))))
       order by c.id
       limit 1
       for update;

      if found then
        v_take := not v_had_addr and v_full;
        update public.customers c set
          visits            = coalesce(c.visits, 0) + 1,
          total_spent       = (round((coalesce(c.total_spent, 0)::numeric + v_amount) * 100) / 100)::real,
          last_visit_at     = case when c.last_visit_at is null or v_at > c.last_visit_at then v_at else c.last_visit_at end,
          last_order_at     = case when c.last_visit_at is null or v_at > c.last_visit_at then v_at else c.last_order_at end,
          last_order_amount = case when c.last_visit_at is null or v_at > c.last_visit_at then v_amount else c.last_order_amount end,
          first_order_at    = case when c.first_order_at is null or v_at < c.first_order_at then v_at else c.first_order_at end,
          address           = case when v_take then v_addr else c.address end,
          city              = case when v_take then v_city else c.city end,
          state             = case when v_take then v_state else c.state end,
          zip               = case when v_take then v_zip else c.zip end,
          email             = case when coalesce(c.email, '') = '' and v_email is not null then v_email else c.email end,
          phone             = case when coalesce(c.phone, '') = '' and v_phone is not null then v_phone else c.phone end,
          name              = case when coalesce(btrim(c.name), '') = '' and v_name is not null then v_name else c.name end
        where c.id = v_cid;
        n_upd := n_upd + 1;
        if v_take then n_addr := n_addr + 1; end if;
      else
        -- A suppressed address is flagged on insert by WP4's customers_optout_guard.
        insert into public.customers
          (user_id, name, email, phone, visits, total_spent, last_order_amount, status,
           last_visit_at, last_order_at, first_order_at, sms_consent,
           address, city, state, zip)
        values
          (v_user, coalesce(v_name, v_email, 'Customer'), v_email, v_phone, 1, v_amount::real, v_amount, 'active',
           v_at, v_at, v_at, false,
           case when v_full then v_addr end, case when v_full then v_city end,
           case when v_full then v_state end, case when v_full then v_zip end)
        returning id into v_cid;
        n_new := n_new + 1;
        if v_full then n_addr := n_addr + 1; end if;
      end if;

      -- POS opt-out (contract C2). The POS address, and the matched customer's own address
      -- when it differs (a phone match is the same person), go on the business's
      -- suppression list; every customer row with either address is flagged.
      if v_opt then
        v_n := 0;
        if v_email is not null then
          v_n := v_n + public.clicktide_email_optout(v_user, v_email, 'pos');
        end if;
        if v_cid_email is not null and v_cid_email is distinct from v_email then
          v_n := v_n + public.clicktide_email_optout(v_user, v_cid_email, 'pos');
        end if;
        if v_email is null and v_cid_email is null then
          -- No address to suppress yet: flag the row so an address added later stays opted out.
          update public.customers c set email_unsubscribed_at = now()
           where c.id = v_cid and c.email_unsubscribed_at is null;
          get diagnostics v_n = row_count;
        end if;
        if v_n > 0 then n_opt := n_opt + 1; end if;
      end if;

      -- Retention engine visit history. Cancelled / refunded orders aren't visits.
      if not v_void then
        begin
          perform public.clicktide_record_visit(v_user, v_cid, v_at, v_amount, v_platform, v_id);
          n_visit := n_visit + 1;
        exception
          when others then
            raise warning 'clicktide_pos_apply_orders: record_visit failed for % / %: %', p_connection, v_id, sqlerrm;
        end;
      end if;
      n_applied := n_applied + 1;
    exception
      when raise_exception then
        -- enforce_customer_cap; the ledger row rolls back with the order.
        if sqlerrm like 'PLAN_CUSTOMER_LIMIT_REACHED%' then n_cap := n_cap + 1; else n_fail := n_fail + 1; end if;
      when others then
        n_fail := n_fail + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'applied', n_applied, 'duplicates', n_dup, 'updated', n_upd,
                            'created', n_new, 'capped', n_cap, 'failed', n_fail,
                            'addresses', n_addr, 'opted_out', n_opt, 'visits_recorded', n_visit);
end;
$$;
revoke all on function public.clicktide_pos_apply_orders(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.clicktide_pos_apply_orders(uuid, jsonb) to service_role;

-- Retention of expired oauth_pending / oauth_states rows is done by platform-sync at the
-- end of each scheduled run (no cron job here). pos_order_ledger is kept: it is what makes
-- re-reads and reconnects safe, and audit_delete removes a business's rows with the rest
-- of its data.
