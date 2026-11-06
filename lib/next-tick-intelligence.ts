/**
 * Causal, online all-ten-digit next-tick evaluator. No outcome is used before it arrives.
 * Relative V1 scores and estimated probabilities are NOT evidence of an edge.
 * Keep one engine per symbol + pip size; call observe once per distinct tick.
 */
import {scoreDigits, type DigitScore} from './digitmatch-score';

export type ExpertName = 'frequency'|'transition'|'gap'|'momentum'|'entropy';
const EXPERTS:ExpertName[]=['frequency','transition','gap','momentum','entropy'];
export type DigitForecast=DigitScore & {probability:number;momentum3:number;positiveSteps:number;entropy:number;sampleHits:number;sampleTrials:number};
export type IntelligenceAudit={trials:number;topHits:number;topHitRate:number;brier:number;logLoss:number;uniformBrier:number;digitTrials:number[];digitHits:number[];digitObserved:number[];weights:Record<ExpertName,number>};
const clip=(x:number,a:number,b:number)=>Math.min(b,Math.max(a,x));
const normalize=(numbers:number[])=>{const sum=numbers.reduce((a,b)=>a+b,0);return sum>0?numbers.map(x=>x/sum):Array(10).fill(.1)};
const softmax=(v:number[],temperature:number)=>{const m=Math.max(...v);return normalize(v.map(x=>Math.exp(clip((x-m)/temperature,-40,40))))};
const win=(h:number[],n:number)=>h.slice(-n);
const entropy=(h:number[])=>{if(!h.length)return 0;const cs=Array(10).fill(0);for(const d of h)cs[d]++;return -cs.reduce((a,c)=>c?a+(c/h.length)*Math.log2(c/h.length):a,0)/Math.log2(10)};
const smoothed=(h:number[],d:number,alpha:number)=> (h.filter(x=>x===d).length+alpha)/(h.length+10*alpha);
const wilsonLower=(hits:number,n:number)=>{if(n===0)return 0;const z=1.96,p=hits/n,z2=z*z;return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n)};

export class NextTickIntelligence {
 private history:number[]=[];
 private scoreTrail:Record<number,number>[]=[];
 private pending:{predicted:number;combined:number[];experts:Record<ExpertName,number[]>}|null=null;
 private expertLoss:Record<ExpertName,number>={frequency:0,transition:0,gap:0,momentum:0,entropy:0};
 private outcomes:{predicted:number;actual:number;probs:number[];brier:number;logLoss:number}[]=[];
 private counts=Array(10).fill(0);
 private latest:DigitForecast[]=[];
 private weights:Record<ExpertName,number>={frequency:.2,transition:.2,gap:.2,momentum:.2,entropy:.2};
 reset(){this.history=[];this.scoreTrail=[];this.pending=null;this.outcomes=[];this.counts=Array(10).fill(0);this.expertLoss={frequency:0,transition:0,gap:0,momentum:0,entropy:0};this.latest=[];this.weights={frequency:.2,transition:.2,gap:.2,momentum:.2,entropy:.2};}
 /** Grades the forecast frozen on the PREVIOUS tick before adding the current digit. */
 observe(actual:number):DigitForecast[]{
  if(!Number.isInteger(actual)||actual<0||actual>9)return this.latest;
  if(this.pending){
   const p=this.pending;
   const brier=p.combined.reduce((s,v,d)=>s+(v-Number(d===actual))**2,0);
   this.outcomes.push({predicted:p.predicted,actual,probs:[...p.combined],brier,logLoss:-Math.log(Math.max(1e-8,p.combined[actual]))});
   if(this.outcomes.length>1000)this.outcomes.shift();
   for(const name of EXPERTS){const loss=-Math.log(Math.max(.0001,p.experts[name][actual]));this.expertLoss[name]=clip(.985*this.expertLoss[name]+.015*loss,0,10)};
   this.counts[actual]++;
  }
  this.history=[...this.history.slice(-199),actual];
  const base=scoreDigits(this.history);
  if(base.length!==10){this.pending=null;this.latest=[];return []}
  const snapshot:Record<number,number>={};for(const row of base)snapshot[row.digit]=row.score;
  this.scoreTrail=[...this.scoreTrail.slice(-3),snapshot];
  const n=this.history.length, recent=win(this.history,25),current=this.history[n-1];
  const e=entropy(recent);
  const freq=normalize(Array.from({length:10},(_,d)=> .42*smoothed(win(this.history,10),d,3)+.35*smoothed(win(this.history,30),d,4)+.23*smoothed(win(this.history,100),d,7)));
  const transition=normalize(Array.from({length:10},(_,d)=>{
   let s1=0,c1=0,s2=0,c2=0;
   for(let i=0;i<n-1;i++)if(this.history[i]===current){c1++;if(this.history[i+1]===d)s1++}
   for(let i=0;i<n-2;i++)if(this.history[i]===this.history[n-2]&&this.history[i+1]===current){c2++;if(this.history[i+2]===d)s2++}
   return .6*(s1+3)/(c1+30)+.4*(s2+2)/(c2+20);
  }));
  const gap=normalize(Array.from({length:10},(_,d)=>{
   let i=n-1;while(i>=0&&this.history[i]!==d)i--;
   const g=i<0?50:n-1-i;
   // Gap is contextual evidence only, NOT a gambler's fallacy or due-digit guarantee.
   return Math.exp(-Math.abs(Math.min(g,25)-7)/12);
  }));
  const trail=this.scoreTrail;
  const momentum=Array.from({length:10},(_,d)=>{
   if(trail.length<4)return {change:0,rises:0};
   const vals=trail.map(x=>x[d]);return {change:vals[3]-vals[0],rises:vals.slice(1).filter((v,i)=>v>vals[i]).length};
  });
  const mom=softmax(momentum.map(x=>clip(x.change,-12,12)+1.5*(x.rises-1.5)),8);
  // Low entropy can indicate concentration but is not by itself predictability.
  const lowEntropy=1-e;
  const ent=normalize(Array.from({length:10},(_,d)=> .1 + lowEntropy*clip((smoothed(win(this.history,25),d,3)-.1),-.08,.15)));
  const experts:Record<ExpertName,number[]>={frequency:freq,transition,gap,momentum:mom,entropy:ent};
  // Online expert weights are based only on already-observed next-tick results.
  // Shrink towards equal weights until enough observations accumulate.
  const learned=softmax(EXPERTS.map(k=>-this.expertLoss[k]),.14);
  const maturity=clip(this.outcomes.length/250,0,.65);
  for(let i=0;i<EXPERTS.length;i++)this.weights[EXPERTS[i]]=(1-maturity)/5+maturity*learned[i];
  const combined=normalize(Array.from({length:10},(_,d)=>{
   const p=EXPERTS.reduce((sum,k)=>sum+this.weights[k]*experts[k][d],0);
   // Entropy-sensitive shrinkage towards 10%: less empirical structure => less confidence.
   const shrink=clip(.32+.42*e,.32,.74);
   return shrink*.1+(1-shrink)*p;
  }));
  const perDigit=new Array(10).fill(0).map((_,d)=>{
   const trials=this.outcomes.length;
   const hits=this.outcomes.filter(o=>o.predicted===d&&o.actual===d).length;
   const selections=this.outcomes.filter(o=>o.predicted===d).length;
   return {hits,selections,trials};
  });
  this.latest=base.map(r=>{
   const d=r.digit;
   // Keep V1 score scale for existing Min Score control; probabilities act as
   // a calibrated *ranking adjustment*, not a claimed percentage advantage.
   const score=r.score+clip(55*(combined[d]-.1),-3,3);
   return {...r,score,probability:combined[d],momentum3:momentum[d].change,positiveSteps:momentum[d].rises,entropy:e,sampleHits:perDigit[d].hits,sampleTrials:perDigit[d].selections};
  }).sort((a,b)=>b.score-a.score||b.probability-a.probability||a.digit-b.digit);
  this.pending={predicted:this.latest[0].digit,combined:[...combined],experts};
  return this.latest;
 }
 getForecast(){return this.latest}
 getAudit():IntelligenceAudit{
  const rows=this.outcomes,n=rows.length,topHits=rows.filter(o=>o.actual===o.predicted).length;
  return {trials:n,topHits,topHitRate:n?topHits/n:0,
   brier:n?rows.reduce((s,o)=>s+o.brier,0)/n:0,
   logLoss:n?rows.reduce((s,o)=>s+o.logLoss,0)/n:0,
   uniformBrier:.9,
   digitTrials:Array.from({length:10},(_,d)=>rows.filter(o=>o.predicted===d).length),
   digitHits:Array.from({length:10},(_,d)=>rows.filter(o=>o.predicted===d&&o.actual===d).length),
   digitObserved:[...this.counts],weights:{...this.weights}};
 }
 getLower95(){const a=this.getAudit();return wilsonLower(a.topHits,a.trials)}
}
