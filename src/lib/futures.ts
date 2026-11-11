import { z } from "zod";
export const futuresTicket = z.object({
 connectionId: z.string().uuid(), symbol: z.string().regex(/^[A-Z0-9]{2,16}\/USDT$/), side: z.enum(["buy", "sell"]),
 margin: z.number().finite().positive(), leverage: z.number().int().min(1).max(20),
 slPct: z.number().finite().min(0.05).max(5), tpPct: z.number().finite().min(0.05).max(5), holdMin: z.number().int().min(1).max(240),
 requestId: z.string().uuid(), confirmation: z.enum(["TESTNET", "LIVE"]),
});
export type FuturesTicket = z.infer<typeof futuresTicket>;
export const futuresLimits = z.object({ connectionId: z.string().uuid(), enabled: z.boolean(), maxMargin: z.number().finite().positive(), maxLeverage: z.number().int().min(1).max(20), maxLoss: z.number().finite().positive(), confirmation: z.string() });
export function futuresQuantity(margin: number, leverage: number, price: number, step: number, minQty: number, minNotional: number) {
 if (![margin,leverage,price,step].every(n=>Number.isFinite(n)&&n>0)) throw new Error("Invalid Futures sizing");
 const qty = Number((Math.floor(margin*leverage/price/step)*step).toFixed(12));
 if (qty < minQty || qty*price < minNotional) throw new Error("Margin is below Binance's minimum order size");
 return qty;
}
export function futuresPrices(side: "buy"|"sell", price: number, slPct: number, tpPct: number, tick: number) {
 if (![price,slPct,tpPct,tick].every(n=>Number.isFinite(n)&&n>0)) throw new Error("Invalid Futures stop or target");
 const round = (n:number,up:boolean)=>Number(((up?Math.ceil(n/tick):Math.floor(n/tick))*tick).toFixed(12));
 const long=side==='buy';
 const sl=round(price*(1+(long?-slPct:slPct)/100),long);
 const tp=round(price*(1+(long?tpPct:-tpPct)/100),!long);
 if(long?!(sl<price&&tp>price):!(sl>price&&tp<price)) throw new Error("Stop or target is too close for the symbol tick size");
 return {sl,tp};
}
/** Fee buffer is a conservative safety reserve, not a claim about the owner's Binance fee tier. */
export function futuresRiskReserve(notional:number,slPct:number) {return notional*(slPct/100+0.002);}
export function futuresLimitProblem(t:Pick<FuturesTicket,'margin'|'leverage'|'slPct'>,s:{max_margin:number|null;max_leverage:number|null;max_loss:number|null}) {
 if(s.max_margin==null||s.max_leverage==null||s.max_loss==null) return "Save explicit Futures risk limits first";
 if(t.margin>s.max_margin) return "Futures margin limit exceeded";
 if(t.leverage>s.max_leverage) return "Futures leverage limit exceeded";
 if(futuresRiskReserve(t.margin*t.leverage,t.slPct)>s.max_loss) return "Futures maximum loss reserve exceeded";
 return null;
}
