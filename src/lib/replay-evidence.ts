import {runBacktest} from "./backtest";
import {runBacktestV3} from "./backtest-v3";
import {evidenceHash} from "./evidence-hash";
import {evaluationEvidence} from "./evaluation";
import {validateStrategy,type StrategyConfig} from "./strategy";
export async function replayMatches(input:unknown,capital:number){
  try{
    const p=evaluationEvidence.safeParse(input);if(!p.success||capital<=0)return false;
    const m=p.data.manifest,config=m['config'] as StrategyConfig;
    if(!config||validateStrategy(config).length||typeof m['tfMs']!=="number"||m['tfMs']<=0)return false;
    const replay=m.simulatorVersion==="next-bar-v3"
      ?runBacktestV3(config,m.candles,{capital,tfMs:m['tfMs'],market:m['market']==="futures"?"futures":"spot",costs:{feePct:m.feePct,slippagePct:m.slippagePct,spreadPct:Number(m['spreadPct']??0),maxParticipationPct:m['maxParticipationPct']==null?null:Number(m['maxParticipationPct'])}})
      :runBacktest(config,m.candles,{capital,feePct:m.feePct,slippagePct:m.slippagePct,tfMs:m['tfMs']});
    return await evidenceHash({trades:replay.trades,equity:replay.equity})===await evidenceHash({trades:p.data.trades,equity:p.data.equity});
  }catch{return false;}
}