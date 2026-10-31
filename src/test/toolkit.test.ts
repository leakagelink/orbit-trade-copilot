import { describe,it,expect } from "vitest";
import { alertHit,csvCell,tradeCsv } from "@/lib/toolkit";
describe("price alerts",()=>{
  it("fires at or above an above target",()=>{expect(alertHit("above",100,100)).toBe(true);expect(alertHit("above",100,99)).toBe(false);});
  it("fires at or below a below target",()=>{expect(alertHit("below",100,100)).toBe(true);expect(alertHit("below",100,101)).toBe(false);});
  it("rejects unavailable or invalid prices",()=>{for(const p of [NaN,Infinity,0,-1]) expect(alertHit("below",100,p)).toBe(false);});
});
describe("trade export",()=>{
  it("escapes commas, quotes and spreadsheet formulas",()=>{expect(csvCell('a,"b"')).toBe('"a,""b"""');expect(csvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');expect(csvCell(-5)).toBe('"-5"');});
  it("subtracts fees exactly once for net P&L",()=>{
    const csv=tradeCsv([{id:"trade",trading_pair:"BTC/USDT",side:"buy",mode:"paper",opened_at:"2026-10-31T00:00:00Z",closed_at:null,entry_price:100,exit_price:110,quantity:1,realized_pnl:10,fees:2,close_reason:"target"}]);
    expect(csv.split("\r\n")[1]).toContain('"10","2","8"');
  });
});