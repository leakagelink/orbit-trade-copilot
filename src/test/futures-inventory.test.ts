import { afterEach, expect, it, vi } from 'vitest';
import { futuresPositions } from '@/lib/binance-futures.server';
import { bindCredentials } from '@/lib/binance-futures-env';
const account={connectionId:'test-only',testnet:true,creds:bindCredentials({apiKey:'test-key',apiSecret:'test-secret'},'testnet')};
afterEach(()=>vi.unstubAllGlobals());
it('requires explicit zero inventory when V3 omits a flat symbol',async()=>{
 const urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(url);return Response.json(url.includes('/v3/')?[]:[{symbol:'DOGEUSDT',positionSide:'BOTH',positionAmt:'0'}]);}));
 expect((await futuresPositions(account,'DOGEUSDT'))[0]?.positionAmt).toBe('0');
 expect(urls).toHaveLength(2);
 expect(urls.every(url=>url.startsWith('https://testnet.binancefuture.com/'))).toBe(true);
});
it('keeps recovery locked when both inventory endpoints omit the symbol',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([])));
 await expect(futuresPositions(account,'DOGEUSDT')).rejects.toThrow('recovery remains locked');
});
it('does not fall back when V3 has actual exposure',async()=>{
 const fetcher=vi.fn(async()=>Response.json([{symbol:'DOGEUSDT',positionSide:'BOTH',positionAmt:'76'}]));vi.stubGlobal('fetch',fetcher);
 expect((await futuresPositions(account,'DOGEUSDT'))[0]?.positionAmt).toBe('76');expect(fetcher).toHaveBeenCalledTimes(1);
});