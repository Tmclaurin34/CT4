-- Gift wallet support fields.
-- Additive only: lets the back office record wallet credits, debits, and refunds clearly.

alter table public.wallet
  add column if not exists transaction_type text default 'adjustment',
  add column if not exists note text,
  add column if not exists created_by uuid;

