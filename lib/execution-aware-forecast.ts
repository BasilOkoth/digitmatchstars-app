/** Execution-aware research layer for DigitMatchStars.
 * Forecasts at +1..+4 observed ticks are frozen at signal time and scored only
 * after their specified future tick. The inferred horizon is an ACK-lag proxy,
 * NOT a verified contract-expiry position. Never call a browser match a WIN.
 */
import type {DigitForecast} from './next-tick-intelligence';

const LIMIT=4;
const norm=(v:number[])=>{const s=v.reduce((a,b)=>a+b,0);return s>0?v.map(x=>x/s):Array(10).fill(.1)};
const wilson=(k:number,n:number)=>{if(!n)return 0;const z=1.96,p=k/n,z2=z*z;return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n)};
export type HorizonAudit={horizon:number;trials:number;hits:number;hitRate:number;lower95:number;logLoss:number};
type Pending={due:number;horizon:number;chosen:number;probs:number[]};
export class ExecutionAwareForecast {
 private history:number[]=[];
 private index=0;
 private pending:Pending[]=[];
 private stats=Array.from({length:LIMIT},()=>({trials:0,hits:0,logLossSum:0}));
 private ackLags:number[]=[];
 private outcomes={trades:0,wins:0};
 reset(){this.history=[];this.index=0;this.pending=[];this.stats=Array.from({length:LIMIT},()=>({trials:0,hits:0,logLossSum:0}));this.ackLags=[];this.outcomes={trades:0,wins:0}}
 observe(digit:number){
  if(!Number.isInteger(digit)||digit<0||digit>9)return;
  this.index++;
  for(const p of this.pending){if(p.due!==this.index)continue;
   const s=this.stats[p.horizon-1];s.trials++;s.hits+=Number(p.chosen===digit);
   s.logLossSum+=-Math.log(Math.max(1e-9,p.probs[digit]));
  }
  this.pending=this.pending.filter(p=>p.due>this.index);
  this.history.push(digit);if(this.history.length>1200)this.history.shift();
 }
 // Send the ACK delay as a proxy, not the true contract settlement horizon.
 observeAcknowledgment(ticksBetweenSignalAndAck:number){
  if(!Number.isInteger(ticksBetweenSignalAndAck)||ticksBetweenSignalAndAck<0||ticksBetweenSignalAndAck>30)return;
  this.ackLags.push(ticksBetweenSignalAndAck);if(this.ackLags.length>100)this.ackLags.shift();
 }
 observeSettlement(won:boolean){this.outcomes.trades++;this.outcomes.wins+=Number(won)}
 getHorizon():number{
  // No evidence of the expiry position until exchange-supplied entry/exit ticks
  // can be unambiguously mapped. The following is explicitly a timing proxy.
  if(this.ackLags.length<5)return 2;
  const sorted=[...this.ackLags].sort((a,b)=>a-b);
  return Math.max(1,Math.min(LIMIT,1+sorted[Math.floor(sorted.length/2)]));
 }
 /** The model's immediate +1 forecast is blended with a smoothed Markov
  * transition model projected to the estimated forward horizon. All counts
  * come from completed historical transitions, never future observations.
  */
 forecast(rows:DigitForecast[]){
  if(rows.length!==10||!this.history.length)return null;
  const h=this.getHorizon();
  const base=Array.from({length:10},(_,d)=>rows.find(r=>r.digit===d)?.probability??.1);
  const counts=Array.from({length:10},()=>Array(10).fill(5));
  for(let i=0;i<this.history.length-1;i++)counts[this.history[i]][this.history[i+1]]++;
  const matrix=counts.map(row=>norm(row));
  let forward=norm(base);
  for(let step=2;step<=h;step++){
   const after=Array(10).fill(0);
   for(let a=0;a<10;a++)for(let b=0;b<10;b++)after[b]+=forward[a]*matrix[a][b];
   forward=norm(after);
  }
  // Strong uniform prior with only a limited contribution from horizon model.
  // Estimated performance, not proof of non-random outcomes.
  const probs=norm(forward.map(p=>.65*.1+.35*p));
  const ranked=rows.map(r=>({...r,executionProbability:probs[r.digit],forecastHorizon:h}))
   .sort((a,b)=>b.executionProbability-a.executionProbability||b.probability-a.probability||a.digit-b.digit);
  // Every horizon gets a frozen pre-outcome audit, including the current one.
  for(let k=1;k<=LIMIT;k++){
   let pk=norm(base);
   for(let step=2;step<=k;step++){
    const after=Array(10).fill(0);for(let a=0;a<10;a++)for(let b=0;b<10;b++)after[b]+=pk[a]*matrix[a][b];pk=norm(after);
   }
   const frozen=norm(pk.map(p=>.65*.1+.35*p));
   const chosen=frozen.indexOf(Math.max(...frozen));
   this.pending.push({due:this.index+k,horizon:k,chosen,probs:frozen});
  }
  return {horizon:h,ranked};
 }
 audit():{horizon:number;ackSamples:number;horizons:HorizonAudit[];verifiedTrades:number;verifiedWins:number}{
  return {horizon:this.getHorizon(),ackSamples:this.ackLags.length,
   horizons:this.stats.map((s,i)=>({horizon:i+1,trials:s.trials,hits:s.hits,hitRate:s.trials?s.hits/s.trials:0,lower95:wilson(s.hits,s.trials),logLoss:s.trials?s.logLossSum/s.trials:0})),verifiedTrades:this.outcomes.trades,verifiedWins:this.outcomes.wins};
 }
}
