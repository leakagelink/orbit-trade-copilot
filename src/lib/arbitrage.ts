/** Browser-safe executable-depth math; never use last-trade prices for arbitrage. */
export const ARBITRAGE_EXCHANGES = ["binance", "bybit", "okx", "kucoin"] as const;
export const ARBITRAGE_PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT", "DOGE/USDT"] as const;
export type ArbitrageExchange = typeof ARBITRAGE_EXCHANGES[number];
export interface Book { exchange: string; bids: [number, number][]; asks: [number, number][]; fetchedAt: number }
export interface Opportunity {
  buyExchange: string; sellExchange: string; quantity: number; buyCost: number; sellValue: number;
  buyPrice: number; sellPrice: number; fees: number; slippage: number; net: number; netPct: number; fetchedAt: number;
}

export function depthFill(levels: [number, number][], quantity: number): number | null {
  let left = quantity, value = 0;
  for (const [price, size] of levels) {
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    const take = Math.min(left, size); value += take * price; left -= take;
    if (left <= quantity * 1e-10) return value;
  }
  return null;
}

export function compareBooks(books: Book[], budget: number, feeBps: number, slippageBps: number, now = Date.now()): Opportunity[] {
  if (!(budget > 0) || feeBps < 0 || slippageBps < 0) return [];
  const opportunities: Opportunity[] = [];
  for (const buy of books) for (const sell of books) {
    if (buy.exchange === sell.exchange || now - buy.fetchedAt > 15000 || now - sell.fetchedAt > 15000) continue;
    const ask = buy.asks[0]?.[0]; if (!ask || ask <= 0) continue;
    // Find the base size affordable within the quote budget at actual depth.
    let remaining = budget, quantity = 0;
    for (const [price, size] of buy.asks) {
      if (!(price > 0 && size > 0)) continue;
      const take = Math.min(size, remaining / price); quantity += take; remaining -= take * price;
      if (remaining <= budget * 1e-10) break;
    }
    if (remaining > budget * 1e-8 || quantity <= 0) continue;
    const buyCost = depthFill(buy.asks, quantity), sellValue = depthFill(sell.bids, quantity);
    if (buyCost == null || sellValue == null) continue;
    const fees = (buyCost + sellValue) * feeBps / 10000;
    const slippage = (buyCost + sellValue) * slippageBps / 10000;
    const net = sellValue - buyCost - fees - slippage;
    opportunities.push({ buyExchange: buy.exchange, sellExchange: sell.exchange, quantity, buyCost, sellValue,
      buyPrice: buyCost / quantity, sellPrice: sellValue / quantity, fees, slippage, net, netPct: net / buyCost * 100,
      fetchedAt: Math.min(buy.fetchedAt, sell.fetchedAt) });
  }
  return opportunities.sort((a, b) => b.net - a.net);
}

export function executionAllowed(opportunity: Opportunity, minimumNetPct: number): boolean {
  return opportunity.net > 0 && opportunity.netPct >= minimumNetPct;
}