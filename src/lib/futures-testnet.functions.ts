import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import type { BrokerPosition, BrokerOrder, AlgoOrder } from './binance-futures.server';

/** Read-only certification evidence. Never selects a production account or changes risk/configuration. */
export const inspectFuturesTestnet = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ connectionId: z.string().uuid(), symbol: z.string().regex(/^[A-Z0-9]{2,16}\/USDT$/) }))
  .handler(async ({ data, context }) => {
    const owned = await context.supabase.from('exchange_connections').select('id,exchange,is_testnet,status,account_type').eq('id', data.connectionId).eq('user_id', context.userId).single();
    if (owned.error || !owned.data || owned.data.exchange !== 'binance' || owned.data.is_testnet !== true) throw new Error('Binance Futures Testnet account required; production access forbidden');
    const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
    const { loadFuturesAccount } = await import('./futures.server');
    const a = await loadFuturesAccount(db, context.userId, data.connectionId);
    if (a.testnet !== true) throw new Error('Testnet environment changed; inspection stopped');
    const { futuresAccountState, futuresSymbol, futuresCall, futuresHost } = await import('./binance-futures.server');
    const symbol = data.symbol.replace('/', '');
    const [account, contract, positions, orders, algos, configuration, risk, limits, lease, intents, ledger] = await Promise.all([
      futuresAccountState(a), futuresSymbol(a, data.symbol),
      futuresCall<BrokerPosition[]>(a, 'GET', '/fapi/v3/positionRisk'),
      futuresCall<BrokerOrder[]>(a, 'GET', '/fapi/v1/openOrders'),
      futuresCall<AlgoOrder[]>(a, 'GET', '/fapi/v1/openAlgoOrders'),
      futuresCall<{symbol:string;marginType:string;leverage:number}[]>(a, 'GET', '/fapi/v1/symbolConfig', { symbol }),
      // Only the emergency-stop flag; Testnet limits are fixed and the production limit records are not read.
      context.supabase.from('risk_settings').select('trading_halted').eq('user_id', context.userId).maybeSingle(),
      import('./futures-testnet-limits').then((m) => ({ data: m.TESTNET_FUTURES_LIMITS, error: null })),
      context.supabase.from('futures_execution_leases').select('fence,purpose,expires_at').eq('connection_id', data.connectionId),
      context.supabase.from('orders').select('id,client_order_id,exchange_order_id,status,quantity,filled_quantity,avg_fill_price,idempotency_key,created_at').eq('exchange_connection_id', data.connectionId).eq('execution_environment', 'testnet').order('created_at', { ascending: false }).limit(30),
      context.supabase.from('trades').select('position_id,trading_pair,quantity,entry_price,exit_price,realized_pnl,funding_pnl,fees,net_pnl,costs_verified,closed_at').eq('exchange_connection_id', data.connectionId).eq('execution_environment', 'testnet').order('closed_at', { ascending: false }).limit(10),
    ]);
    for (const result of [risk, limits, lease, intents, ledger]) if (result.error) throw new Error('Certification database evidence unavailable');
    return { observedAt: new Date().toISOString(), environment: 'TESTNET', host: futuresHost(true), account: { canTrade: account.canTrade, hedge: account.hedge, multiAssets: account.multiAssets, availableBalance: account.availableBalance }, contract, positions, orders, algos, configuration, risk: risk.data, limits: limits.data, lease: lease.data, intents: intents.data, ledger: ledger.data };
  });