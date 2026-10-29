// Strategy config model + validation engine. Pure: shared by browser and server.
export const INDICATORS = ["RSI", "MACD", "EMA", "SMA", "BBANDS", "ATR", "STOCH_RSI", "VOLUME"] as const;
export type IndicatorType = (typeof INDICATORS)[number];

export const INDICATOR_LABELS: Record<IndicatorType, string> = {
  RSI: "RSI",
  MACD: "MACD",
  EMA: "EMA",
  SMA: "SMA",
  BBANDS: "Bollinger Bands",
  ATR: "ATR",
  STOCH_RSI: "Stochastic RSI",
  VOLUME: "Volume (SMA)",
};

export const INDICATOR_DEFAULTS: Record<IndicatorType, Record<string, number>> = {
  RSI: { period: 14 },
  MACD: { fast: 12, slow: 26, signal: 9 },
  EMA: { period: 20 },
  SMA: { period: 50 },
  BBANDS: { period: 20, stddev: 2 },
  ATR: { period: 14 },
  STOCH_RSI: { period: 14, k: 3, d: 3 },
  VOLUME: { period: 20 },
};

export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export const OPERATORS = ["<", ">", "<=", ">=", "crosses_above", "crosses_below"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Indicator {
  id: string; // e.g. "rsi_1"
  type: IndicatorType;
  params: Record<string, number>;
}

export interface Condition {
  left: string; // indicator id or "price"
  operator: Operator;
  right: string; // indicator id, "price", or numeric literal as string
}

export interface StrategyConfig {
  pairs: string[];
  timeframe: string;
  indicators: Indicator[];
  entry: { logic: "all" | "any"; conditions: Condition[] };
  exit: { logic: "all" | "any"; conditions: Condition[] };
  risk: {
    stop_loss_pct: number | null;
    take_profit_pct: number | null;
    trailing_stop_pct: number | null;
    position_size_pct: number;
    capital_allocation: number;
    max_open_positions: number;
    daily_loss_limit_pct: number | null;
  };
}

export function emptyStrategyConfig(): StrategyConfig {
  return {
    pairs: ["BTC/USDT"],
    timeframe: "1h",
    indicators: [],
    entry: { logic: "all", conditions: [] },
    exit: { logic: "any", conditions: [] },
    risk: {
      stop_loss_pct: 2,
      take_profit_pct: 4,
      trailing_stop_pct: null,
      position_size_pct: 10,
      capital_allocation: 1000,
      max_open_positions: 1,
      daily_loss_limit_pct: 5,
    },
  };
}

const PAIR_RE = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

function validateOperand(op: string, ids: Set<string>, path: string, issues: ValidationIssue[]) {
  if (op === "price" || ids.has(op)) return;
  if (op.trim() !== "" && Number.isFinite(Number(op))) return;
  issues.push({ path, message: `"${op}" is not a known indicator, "price", or a number` });
}

export function validateStrategy(cfg: StrategyConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!cfg.pairs.length) issues.push({ path: "pairs", message: "Select at least one trading pair" });
  cfg.pairs.forEach((p, i) => {
    if (!PAIR_RE.test(p)) issues.push({ path: `pairs.${i}`, message: `Invalid pair "${p}" (use BASE/QUOTE)` });
  });
  if (!(TIMEFRAMES as readonly string[]).includes(cfg.timeframe))
    issues.push({ path: "timeframe", message: "Unsupported timeframe" });

  const ids = new Set<string>();
  cfg.indicators.forEach((ind, i) => {
    if (ids.has(ind.id)) issues.push({ path: `indicators.${i}`, message: `Duplicate indicator id ${ind.id}` });
    ids.add(ind.id);
    if (!INDICATORS.includes(ind.type)) issues.push({ path: `indicators.${i}`, message: "Unknown indicator" });
    for (const [k, v] of Object.entries(ind.params)) {
      if (!Number.isFinite(v) || v <= 0 || v > 500)
        issues.push({ path: `indicators.${i}.${k}`, message: `${ind.id}.${k} must be between 0 and 500` });
    }
    if (ind.type === "MACD" && ind.params.fast >= ind.params.slow)
      issues.push({ path: `indicators.${i}`, message: "MACD fast period must be shorter than slow period" });
  });

  if (!cfg.entry.conditions.length) issues.push({ path: "entry", message: "Add at least one entry condition" });
  if (!cfg.exit.conditions.length && cfg.risk.stop_loss_pct == null && cfg.risk.take_profit_pct == null)
    issues.push({ path: "exit", message: "Add an exit condition, stop loss, or take profit" });
  (["entry", "exit"] as const).forEach((side) =>
    cfg[side].conditions.forEach((c, i) => {
      validateOperand(c.left, ids, `${side}.${i}.left`, issues);
      validateOperand(c.right, ids, `${side}.${i}.right`, issues);
      if (!OPERATORS.includes(c.operator)) issues.push({ path: `${side}.${i}`, message: "Unknown operator" });
    }),
  );

  const r = cfg.risk;
  if (r.stop_loss_pct == null) issues.push({ path: "risk.stop_loss_pct", message: "A stop loss is required" });
  else if (r.stop_loss_pct <= 0 || r.stop_loss_pct >= 50)
    issues.push({ path: "risk.stop_loss_pct", message: "Stop loss must be between 0% and 50%" });
  if (r.take_profit_pct != null && (r.take_profit_pct <= 0 || r.take_profit_pct > 1000))
    issues.push({ path: "risk.take_profit_pct", message: "Take profit must be between 0% and 1000%" });
  if (r.trailing_stop_pct != null && (r.trailing_stop_pct <= 0 || r.trailing_stop_pct >= 50))
    issues.push({ path: "risk.trailing_stop_pct", message: "Trailing stop must be between 0% and 50%" });
  if (!(r.position_size_pct > 0 && r.position_size_pct <= 100))
    issues.push({ path: "risk.position_size_pct", message: "Position size must be between 0% and 100%" });
  if (!(r.capital_allocation > 0)) issues.push({ path: "risk.capital_allocation", message: "Capital must be positive" });
  if (!Number.isInteger(r.max_open_positions) || r.max_open_positions < 1 || r.max_open_positions > 50)
    issues.push({ path: "risk.max_open_positions", message: "Max open positions must be 1–50" });
  if (r.position_size_pct * r.max_open_positions > 100)
    issues.push({ path: "risk", message: "Position size × max open positions exceeds 100% of capital" });
  if (r.daily_loss_limit_pct != null && (r.daily_loss_limit_pct <= 0 || r.daily_loss_limit_pct > 100))
    issues.push({ path: "risk.daily_loss_limit_pct", message: "Daily loss limit must be between 0% and 100%" });
  return issues;
}
