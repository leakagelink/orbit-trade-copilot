import {expect,it} from "vitest";
import {spotFeeCosts,reconciledRoundTripFees} from "../lib/verified-costs";
it("values base buy fees once against gross net-quantity PnL",()=>{expect(spotFeeCosts("buy","BTC","USDT",100,[{asset:"BTC",amount:0.01}])).toEqual({baseFee:0.01,quoteFee:1});});
it("records quote-currency buy fees",()=>{expect(spotFeeCosts("buy","BTC","USDT",100,[{asset:"USDT",amount:0.1}]).quoteFee).toBe(0.1);});
it("values base-currency sell fees as an inventory cost",()=>{expect(spotFeeCosts("sell","BTC","USDT",100,[{asset:"BTC",amount:0.01}]).quoteFee).toBe(1);});
it("unknown fee currency must not become a zero fee",()=>{expect(()=>spotFeeCosts("buy","BTC","USDT",100,[{asset:"BNB",amount:1}])).toThrow("valuation unavailable");});
it("every report subtracts entry and exit cash fees exactly once",()=>{expect(reconciledRoundTripFees(2,3)).toBe(5);});
it("legacy missing entry fees never become fabricated zero costs",()=>{expect(()=>reconciledRoundTripFees(null,3)).toThrow("unknown");});
it("net report equals actual cash flow when buy fees reduce base inventory",()=>{const fee=spotFeeCosts("buy","BTC","USDT",100,[{asset:"BTC",amount:0.01}]);const qty=10-fee.baseFee;const report=(110-100)*qty-fee.quoteFee;expect(report).toBeCloseTo(110*qty-1000);});