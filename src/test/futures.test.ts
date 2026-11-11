import { describe,it,expect } from 'vitest';
import { futuresTicket,futuresQuantity,futuresPrices,futuresLimitProblem } from '@/lib/futures';
describe('USD-M Futures scalp safety',()=>{
 it('rounds quantity down to market lot step',()=>expect(futuresQuantity(100,2,40000,0.001,0.001,5)).toBe(0.005));
 it('rejects insufficient symbol notional',()=>expect(()=>futuresQuantity(1,1,40000,0.001,0.001,5)).toThrow());
 it('places long stops below and targets above entry',()=>expect(futuresPrices('buy',100,1,2,0.01)).toEqual({sl:99,tp:102}));
 it('places short stops above and targets below entry',()=>expect(futuresPrices('sell',100,1,2,0.01)).toEqual({sl:101,tp:98}));
 it('does not accept leverage over 20',()=>expect(futuresTicket.shape.leverage.safeParse(21).success).toBe(false));
 it('requires a positive bounded holding period',()=>expect(futuresTicket.shape.holdMin.safeParse(0).success).toBe(false));
 it('enforces explicit owner margin limit',()=>expect(futuresLimitProblem({margin:101,leverage:1,slPct:1},{max_margin:100,max_leverage:2,max_loss:10})).toBe('Futures margin limit exceeded'));
 it('enforces explicit owner leverage limit',()=>expect(futuresLimitProblem({margin:10,leverage:3,slPct:1},{max_margin:100,max_leverage:2,max_loss:10})).toBe('Futures leverage limit exceeded'));
 it('enforces stop-loss and fee reserve within owner maximum loss',()=>expect(futuresLimitProblem({margin:100,leverage:2,slPct:1},{max_margin:100,max_leverage:2,max_loss:2})).toBe('Futures maximum loss reserve exceeded'));
});
