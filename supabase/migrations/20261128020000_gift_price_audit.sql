-- Nightly gift price audit (printify-cost-audit, mode "apply").
-- gift_catalog.estimated_cost is the price the business pays for a gift (wallet debit or
-- Shopify usage), and the dashboard and every fulfill function read it from there.
-- The audit records each active gift's real landed cost and moves the price so Clicktide
-- never loses money on a gift and doesn't overcharge when costs fall.
--
-- Costs live in their own server-only tables, NOT as gift_catalog columns: gift_catalog is
-- readable by anyone (active rows), and businesses must not see Clicktide's margins.

create table if not exists public.gift_costs (
  gift_catalog_id uuid primary key references public.gift_catalog(id) on delete cascade,
  provider text,                 -- which provider fulfils this gift today (printify / gelato / customcat)
  cost_product numeric,
  cost_shipping numeric,         -- US first-item shipping
  landed_cost numeric,           -- product + shipping
  target_price numeric,          -- what the pricing rule says the price should be
  checked_at timestamptz,
  check_error text,
  price_locked boolean not null default false, -- true = report only, never change this gift's price
  price_auto_at timestamptz      -- last time the audit changed the price
);

-- One row of settings for the pricing rule. Edit these to change how prices are set.
create table if not exists public.gift_price_rules (
  id smallint primary key default 1 check (id = 1),
  tax_pct numeric not null default 7,                -- sales tax the provider may add to an order
  fee_pct numeric not null default 3,                -- payment processing on the money that pays for it
  min_margin_usd numeric not null default 1.00,
  min_margin_pct numeric not null default 10,        -- margin = the larger of the two
  lower_if_above_usd numeric not null default 2.00,  -- only lower a price when it is this far above target
  max_auto_change_pct numeric not null default 150,  -- bigger moves are reported, not applied
  auto_apply boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.gift_price_rules (id) values (1) on conflict (id) do nothing;

create table if not exists public.gift_price_changes (
  id bigserial primary key,
  gift_catalog_id uuid references public.gift_catalog(id) on delete set null,
  gift_name text,
  old_price numeric,
  new_price numeric,
  landed_cost numeric,
  provider text,
  reason text,
  applied boolean not null default true,
  changed_at timestamptz not null default now()
);
create index if not exists gift_price_changes_changed_at on public.gift_price_changes (changed_at desc);

-- Server-only: RLS on with no policies and no grants, so only the service role can touch them.
alter table public.gift_costs enable row level security;
alter table public.gift_price_rules enable row level security;
alter table public.gift_price_changes enable row level security;
revoke all on public.gift_costs, public.gift_price_rules, public.gift_price_changes from anon, authenticated;
revoke all on sequence public.gift_price_changes_id_seq from anon, authenticated;
