-- Demo wallet (virtual money for manual trading)
create table public.wallets (
  user_id uuid primary key,
  balance numeric(28,8) not null default 0,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.wallets to authenticated;
grant all on public.wallets to service_role;
alter table public.wallets enable row level security;
create policy "own wallet read" on public.wallets for select to authenticated using (auth.uid() = user_id);

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('deposit','withdrawal','trade_open','trade_close')),
  amount numeric(28,8) not null,
  balance_after numeric(28,8) not null,
  position_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index wallet_tx_user_idx on public.wallet_transactions (user_id, created_at desc);
create unique index wallet_tx_position_kind_uq on public.wallet_transactions (position_id, kind) where position_id is not null;
grant select on public.wallet_transactions to authenticated;
grant all on public.wallet_transactions to service_role;
alter table public.wallet_transactions enable row level security;
create policy "own wallet tx read" on public.wallet_transactions for select to authenticated using (auth.uid() = user_id);

-- Atomic balance change + ledger row. Server (service role) only.
create or replace function public.wallet_apply(_user uuid, _amount numeric, _kind text, _position uuid, _note text)
returns numeric language plpgsql security definer set search_path = public as $$
declare b numeric;
begin
  insert into public.wallets (user_id) values (_user) on conflict (user_id) do nothing;
  select balance into b from public.wallets where user_id = _user for update;
  if b + _amount < 0 then raise exception 'Insufficient wallet balance'; end if;
  update public.wallets set balance = b + _amount, updated_at = now() where user_id = _user;
  insert into public.wallet_transactions (user_id, kind, amount, balance_after, position_id, note)
    values (_user, _kind, _amount, b + _amount, _position, _note);
  return b + _amount;
end $$;
revoke execute on function public.wallet_apply(uuid, numeric, text, uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_apply(uuid, numeric, text, uuid, text) to service_role;

-- Billing columns for the payment provider (written by server code only)
alter table public.subscriptions
  add column if not exists price_id text,
  add column if not exists customer_ref text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists environment text;

-- Paid access: active paid plan, or an admin account
create or replace function public.has_pro_access(_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = _uid and plan in ('pro','premium') and status in ('active','trialing')
      and (current_period_end is null or current_period_end > now())
  ) or public.has_role(_uid, 'admin') or public.has_role(_uid, 'super_admin')
$$;
revoke execute on function public.has_pro_access(uuid) from public, anon;
grant execute on function public.has_pro_access(uuid) to authenticated, service_role;

-- Paid-only features: free plan cannot create/change strategies, bots, backtests or AI chats
create policy "pro strategies insert" on public.strategies as restrictive for insert to authenticated with check (public.has_pro_access(auth.uid()));
create policy "pro strategies update" on public.strategies as restrictive for update to authenticated using (public.has_pro_access(auth.uid()));
create policy "pro bots insert" on public.trading_bots as restrictive for insert to authenticated with check (public.has_pro_access(auth.uid()));
create policy "pro bots update" on public.trading_bots as restrictive for update to authenticated using (public.has_pro_access(auth.uid()));
create policy "pro backtests insert" on public.backtests as restrictive for insert to authenticated with check (public.has_pro_access(auth.uid()));
create policy "pro ai insert" on public.ai_sessions as restrictive for insert to authenticated with check (public.has_pro_access(auth.uid()));