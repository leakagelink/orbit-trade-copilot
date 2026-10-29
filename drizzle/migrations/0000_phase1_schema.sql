
create type public.app_role as enum ('user','admin','super_admin');
create type public.trading_mode as enum ('paper','live');
create type public.bot_status as enum ('draft','backtesting','paper_trading','running','paused','stopped','error');
create type public.connection_status as enum ('pending','connected','error','expired','disconnected');
create type public.order_side as enum ('buy','sell');
create type public.order_status as enum ('pending','open','partially_filled','filled','cancelled','rejected');
create type public.strategy_status as enum ('draft','validated','invalid','deployed','archived');

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path=public as $$
begin new.updated_at = now(); return new; end $$;

-- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text, avatar_url text, timezone text default 'UTC', base_currency text not null default 'USDT',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
grant select, insert, update on public.profiles to authenticated; grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "own profile read" on public.profiles for select to authenticated using (auth.uid()=id);
create policy "own profile update" on public.profiles for update to authenticated using (auth.uid()=id);
create policy "own profile insert" on public.profiles for insert to authenticated with check (auth.uid()=id);
create trigger trg_profiles_upd before update on public.profiles for each row execute function public.set_updated_at();

-- roles
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null, created_at timestamptz not null default now(), unique(user_id, role));
grant select on public.user_roles to authenticated; grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create or replace function public.has_role(_user_id uuid, _role public.app_role) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.user_roles where user_id=_user_id and role=_role) $$;
create policy "own roles read" on public.user_roles for select to authenticated using (auth.uid()=user_id or public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'super_admin'));
create policy "super admin manage roles" on public.user_roles for all to authenticated using (public.has_role(auth.uid(),'super_admin')) with check (public.has_role(auth.uid(),'super_admin'));
grant insert, update, delete on public.user_roles to authenticated;

-- subscriptions
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null unique,
  plan text not null default 'free' check (plan in ('free','pro','premium')),
  status text not null default 'active', current_period_end timestamptz, provider text, provider_ref text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
grant select on public.subscriptions to authenticated; grant all on public.subscriptions to service_role;
alter table public.subscriptions enable row level security;
create policy "own sub read" on public.subscriptions for select to authenticated using (auth.uid()=user_id);
create trigger trg_sub_upd before update on public.subscriptions for each row execute function public.set_updated_at();

create table public.billing_events (
  id uuid primary key default gen_random_uuid(), user_id uuid, event_type text not null, provider text,
  payload jsonb not null default '{}', created_at timestamptz not null default now());
create index on public.billing_events(user_id);
grant select on public.billing_events to authenticated; grant all on public.billing_events to service_role;
alter table public.billing_events enable row level security;
create policy "own billing read" on public.billing_events for select to authenticated using (auth.uid()=user_id);

-- signup trigger
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.raw_user_meta_data->>'avatar_url');
  insert into public.user_roles(user_id, role) values (new.id,'user');
  insert into public.subscriptions(user_id, plan) values (new.id,'free');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- exchange connections (no secrets here)
create table public.exchange_connections (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  exchange text not null, label text not null, account_type text not null default 'spot',
  is_testnet boolean not null default false, status public.connection_status not null default 'pending',
  permissions jsonb not null default '{}', api_key_hint text, last_synced_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.exchange_connections(user_id);
grant select, update, delete on public.exchange_connections to authenticated; grant all on public.exchange_connections to service_role;
alter table public.exchange_connections enable row level security;
create policy "own exch read" on public.exchange_connections for select to authenticated using (auth.uid()=user_id);
create policy "own exch update" on public.exchange_connections for update to authenticated using (auth.uid()=user_id);
create policy "own exch delete" on public.exchange_connections for delete to authenticated using (auth.uid()=user_id);
create trigger trg_exch_upd before update on public.exchange_connections for each row execute function public.set_updated_at();

-- encrypted credentials: service role only
create table public.connection_credentials (
  connection_id uuid primary key references public.exchange_connections(id) on delete cascade,
  user_id uuid not null, ciphertext text not null, iv text not null,
  created_at timestamptz not null default now());
grant all on public.connection_credentials to service_role;
alter table public.connection_credentials enable row level security;

create table public.broker_connections (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  broker text not null, market text not null default 'IN_EQUITY', label text not null,
  status public.connection_status not null default 'pending', permissions jsonb not null default '{}',
  last_synced_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.broker_connections(user_id);
grant select, update, delete on public.broker_connections to authenticated; grant all on public.broker_connections to service_role;
alter table public.broker_connections enable row level security;
create policy "own broker read" on public.broker_connections for select to authenticated using (auth.uid()=user_id);
create policy "own broker delete" on public.broker_connections for delete to authenticated using (auth.uid()=user_id);

-- strategies
create table public.strategies (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  name text not null, description text, status public.strategy_status not null default 'draft',
  source text not null default 'manual' check (source in ('manual','ai','clone','marketplace')),
  current_version int not null default 1, config jsonb not null default '{}',
  validation_errors jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.strategies(user_id);
grant select, insert, update, delete on public.strategies to authenticated; grant all on public.strategies to service_role;
alter table public.strategies enable row level security;
create policy "own strat all" on public.strategies for all to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
create trigger trg_strat_upd before update on public.strategies for each row execute function public.set_updated_at();

create table public.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  user_id uuid not null, version int not null, config jsonb not null, notes text,
  created_at timestamptz not null default now(), unique(strategy_id, version));
grant select, insert on public.strategy_versions to authenticated; grant all on public.strategy_versions to service_role;
alter table public.strategy_versions enable row level security;
create policy "own sv read" on public.strategy_versions for select to authenticated using (auth.uid()=user_id);
create policy "own sv insert" on public.strategy_versions for insert to authenticated with check (auth.uid()=user_id and exists(select 1 from public.strategies s where s.id=strategy_id and s.user_id=auth.uid()));

-- bots
create table public.trading_bots (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  name text not null,
  exchange_connection_id uuid references public.exchange_connections(id) on delete set null,
  strategy_id uuid references public.strategies(id) on delete set null,
  exchange text not null, trading_pair text not null, timeframe text not null default '1h',
  mode public.trading_mode not null default 'paper', status public.bot_status not null default 'draft',
  allocated_capital numeric(28,8) not null default 0 check (allocated_capital >= 0),
  status_reason text, last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.trading_bots(user_id);
grant select, insert, update, delete on public.trading_bots to authenticated; grant all on public.trading_bots to service_role;
alter table public.trading_bots enable row level security;
create policy "own bots all" on public.trading_bots for all to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
create trigger trg_bots_upd before update on public.trading_bots for each row execute function public.set_updated_at();

create table public.bot_configurations (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null unique references public.trading_bots(id) on delete cascade,
  user_id uuid not null,
  position_size_pct numeric(8,4) not null default 10 check (position_size_pct > 0 and position_size_pct <= 100),
  max_exposure_pct numeric(8,4) not null default 50 check (max_exposure_pct > 0 and max_exposure_pct <= 100),
  stop_loss_pct numeric(8,4) check (stop_loss_pct > 0 and stop_loss_pct < 100),
  take_profit_pct numeric(8,4) check (take_profit_pct > 0),
  max_open_positions int not null default 1 check (max_open_positions > 0),
  daily_loss_limit_pct numeric(8,4) check (daily_loss_limit_pct > 0),
  extra jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
grant select, insert, update, delete on public.bot_configurations to authenticated; grant all on public.bot_configurations to service_role;
alter table public.bot_configurations enable row level security;
create policy "own botcfg all" on public.bot_configurations for all to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id and exists(select 1 from public.trading_bots b where b.id=bot_id and b.user_id=auth.uid()));
create trigger trg_botcfg_upd before update on public.bot_configurations for each row execute function public.set_updated_at();

create table public.bot_logs (
  id uuid primary key default gen_random_uuid(), bot_id uuid not null references public.trading_bots(id) on delete cascade,
  user_id uuid not null, level text not null default 'info', message text not null, data jsonb,
  created_at timestamptz not null default now());
create index on public.bot_logs(bot_id, created_at desc);
grant select, insert on public.bot_logs to authenticated; grant all on public.bot_logs to service_role;
alter table public.bot_logs enable row level security;
create policy "own botlogs read" on public.bot_logs for select to authenticated using (auth.uid()=user_id);
create policy "own botlogs insert" on public.bot_logs for insert to authenticated with check (auth.uid()=user_id and exists(select 1 from public.trading_bots b where b.id=bot_id and b.user_id=auth.uid()));

-- trading records: written by backend only
create table public.orders (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  bot_id uuid references public.trading_bots(id) on delete set null,
  exchange_connection_id uuid references public.exchange_connections(id) on delete set null,
  exchange text not null, trading_pair text not null, mode public.trading_mode not null,
  side public.order_side not null, order_type text not null, quantity numeric(28,8) not null check (quantity>0),
  price numeric(28,8), filled_quantity numeric(28,8) not null default 0, avg_fill_price numeric(28,8),
  status public.order_status not null default 'pending', exchange_order_id text,
  idempotency_key text not null, reject_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key));
create index on public.orders(user_id, created_at desc);
create table public.positions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  bot_id uuid references public.trading_bots(id) on delete set null,
  exchange_connection_id uuid references public.exchange_connections(id) on delete set null,
  exchange text not null, trading_pair text not null, mode public.trading_mode not null,
  side public.order_side not null, quantity numeric(28,8) not null, entry_price numeric(28,8) not null,
  current_price numeric(28,8), unrealized_pnl numeric(28,8) not null default 0,
  stop_loss numeric(28,8), take_profit numeric(28,8), is_open boolean not null default true,
  opened_at timestamptz not null default now(), closed_at timestamptz, updated_at timestamptz not null default now());
create index on public.positions(user_id, is_open);
create table public.trades (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  bot_id uuid references public.trading_bots(id) on delete set null,
  strategy_id uuid references public.strategies(id) on delete set null,
  exchange_connection_id uuid references public.exchange_connections(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  exchange text not null, trading_pair text not null, mode public.trading_mode not null,
  side public.order_side not null, quantity numeric(28,8) not null, entry_price numeric(28,8) not null,
  exit_price numeric(28,8), realized_pnl numeric(28,8) not null default 0, fees numeric(28,8) not null default 0,
  slippage numeric(28,8) not null default 0, opened_at timestamptz not null, closed_at timestamptz,
  close_reason text, created_at timestamptz not null default now());
create index on public.trades(user_id, closed_at desc);
create table public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  exchange_connection_id uuid references public.exchange_connections(id) on delete cascade,
  mode public.trading_mode not null, total_value numeric(28,8) not null, available_capital numeric(28,8) not null,
  unrealized_pnl numeric(28,8) not null default 0, captured_at timestamptz not null default now());
create index on public.portfolio_snapshots(user_id, captured_at desc);
grant select on public.orders, public.positions, public.trades, public.portfolio_snapshots to authenticated;
grant all on public.orders, public.positions, public.trades, public.portfolio_snapshots to service_role;
alter table public.orders enable row level security; alter table public.positions enable row level security;
alter table public.trades enable row level security; alter table public.portfolio_snapshots enable row level security;
create policy "own orders read" on public.orders for select to authenticated using (auth.uid()=user_id);
create policy "own pos read" on public.positions for select to authenticated using (auth.uid()=user_id);
create policy "own trades read" on public.trades for select to authenticated using (auth.uid()=user_id);
create policy "own snaps read" on public.portfolio_snapshots for select to authenticated using (auth.uid()=user_id);

-- backtests
create table public.backtests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  strategy_id uuid not null references public.strategies(id) on delete cascade, strategy_version int,
  trading_pair text not null, timeframe text not null, start_date date not null, end_date date not null,
  starting_capital numeric(28,8) not null check (starting_capital>0), fee_pct numeric(8,4) not null default 0.1,
  slippage_pct numeric(8,4) not null default 0.05, status text not null default 'queued', error text,
  created_at timestamptz not null default now(), completed_at timestamptz, check (end_date > start_date));
create index on public.backtests(user_id);
create table public.backtest_results (
  id uuid primary key default gen_random_uuid(), backtest_id uuid not null unique references public.backtests(id) on delete cascade,
  user_id uuid not null, total_return_pct numeric(18,6), net_profit numeric(28,8), max_drawdown_pct numeric(18,6),
  win_rate_pct numeric(8,4), profit_factor numeric(18,6), total_trades int, avg_win numeric(28,8), avg_loss numeric(28,8),
  equity_curve jsonb not null default '[]', trade_log jsonb not null default '[]', created_at timestamptz not null default now());
grant select, insert on public.backtests to authenticated; grant select on public.backtest_results to authenticated;
grant all on public.backtests, public.backtest_results to service_role;
alter table public.backtests enable row level security; alter table public.backtest_results enable row level security;
create policy "own bt read" on public.backtests for select to authenticated using (auth.uid()=user_id);
create policy "own bt insert" on public.backtests for insert to authenticated with check (auth.uid()=user_id);
create policy "own btr read" on public.backtest_results for select to authenticated using (auth.uid()=user_id);

-- AI
create table public.ai_sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, title text not null default 'New conversation',
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.ai_sessions(user_id, updated_at desc);
grant select, insert, update, delete on public.ai_sessions to authenticated; grant all on public.ai_sessions to service_role;
alter table public.ai_sessions enable row level security;
create policy "own ai all" on public.ai_sessions for all to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
create trigger trg_ai_upd before update on public.ai_sessions for each row execute function public.set_updated_at();
create table public.ai_strategy_generations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  session_id uuid references public.ai_sessions(id) on delete set null,
  strategy_id uuid references public.strategies(id) on delete set null,
  prompt text not null, model text, output jsonb, created_at timestamptz not null default now());
grant select, insert on public.ai_strategy_generations to authenticated; grant all on public.ai_strategy_generations to service_role;
alter table public.ai_strategy_generations enable row level security;
create policy "own gen read" on public.ai_strategy_generations for select to authenticated using (auth.uid()=user_id);
create policy "own gen insert" on public.ai_strategy_generations for insert to authenticated with check (auth.uid()=user_id);

-- audit + notifications
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), user_id uuid, action text not null, entity_type text, entity_id uuid,
  details jsonb not null default '{}', created_at timestamptz not null default now());
create index on public.audit_logs(user_id, created_at desc);
grant select, insert on public.audit_logs to authenticated; grant all on public.audit_logs to service_role;
alter table public.audit_logs enable row level security;
create policy "own audit read" on public.audit_logs for select to authenticated using (auth.uid()=user_id or public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'super_admin'));
create policy "own audit insert" on public.audit_logs for insert to authenticated with check (auth.uid()=user_id);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, title text not null, body text,
  kind text not null default 'info', read_at timestamptz, created_at timestamptz not null default now());
create index on public.notifications(user_id, created_at desc);
grant select, update, delete on public.notifications to authenticated; grant all on public.notifications to service_role;
alter table public.notifications enable row level security;
create policy "own notif read" on public.notifications for select to authenticated using (auth.uid()=user_id);
create policy "own notif update" on public.notifications for update to authenticated using (auth.uid()=user_id);
create policy "own notif delete" on public.notifications for delete to authenticated using (auth.uid()=user_id);
