// Exchange / broker adapter registry (metadata only). Live adapters land in Phase 2.
export interface ExchangeMeta {
  id: string;
  name: string;
  kind: "crypto" | "broker";
  market: string;
  orderTypes: string[];
  supportsTestnet: boolean;
  needsPassphrase: boolean;
  available: boolean;
}

export const EXCHANGES: ExchangeMeta[] = [
  { id: "binance", name: "Binance", kind: "crypto", market: "Spot / Futures", orderTypes: ["market", "limit", "stop_loss_limit", "take_profit_limit"], supportsTestnet: true, needsPassphrase: false, available: true },
  { id: "bybit", name: "Bybit", kind: "crypto", market: "Spot / Derivatives", orderTypes: ["market", "limit", "conditional"], supportsTestnet: true, needsPassphrase: false, available: true },
  { id: "okx", name: "OKX", kind: "crypto", market: "Spot / Swap", orderTypes: ["market", "limit", "trigger", "trailing"], supportsTestnet: true, needsPassphrase: true, available: true },
  { id: "kucoin", name: "KuCoin", kind: "crypto", market: "Spot", orderTypes: ["market", "limit", "stop"], supportsTestnet: false, needsPassphrase: true, available: true },
  { id: "coinbase", name: "Coinbase Advanced", kind: "crypto", market: "Spot", orderTypes: ["market", "limit", "stop_limit"], supportsTestnet: false, needsPassphrase: false, available: true },
  { id: "zerodha", name: "Zerodha Kite", kind: "broker", market: "NSE / BSE", orderTypes: ["MARKET", "LIMIT", "SL", "SL-M"], supportsTestnet: false, needsPassphrase: false, available: false },
  { id: "upstox", name: "Upstox", kind: "broker", market: "NSE / BSE", orderTypes: ["MARKET", "LIMIT", "SL"], supportsTestnet: false, needsPassphrase: false, available: false },
];

export const exchangeName = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;
