/** Causal, online next-tick forecasting for all digits 0..9.
 * A forecast is always frozen before the next observation is graded.
 * These are research probabilities; no method here establishes market edge.
 */
import {scoreDigits, type DigitScore} from './digitmatch-score';

export type ExpertName='frequency'|'transition'|'gap'|'momentum'|'entropy';
export type EntropyRegime='LOW'|'MID'|'HIGH';
const NAMES:ExpertName[]=['frequency','transition','gap','momentum','entropy'];
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
const norm=(xs:number[])=>{const total=xs.reduce((a,b)=>a+b,0);return total>0?xs.map(x=>x/total):Array(10).fill(.1)};
const softmax=(xs:number[],temp:number)=>{const m=Math.max(...xs);return norm(xs.map(x=>Math.exp(clamp((x-m)/temp,-30,30))))};
const entropy=(h:number[])=>{if(!h.length)return 1;const c=Array(10).fill(0);h.forEach(x=>c[x]++);return -c.reduce((s,n)=>n?s+(n/h.length)*Math.log2(n/h.length):s,0)/Math.log2(10)};
const avg=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const wilson=(hits:number,n:number)=>{if(!n)return 0;const z=1.96,p=hits/n,z2=z*z;return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n)};
const regimeOf=(e:number):EntropyRegime=>e<.72?'LOW':e<.88?'MID':'HIGH';
const f=(h:number[],d:number,n:number,a:number)=>{const w=h.slice(-n);return (w.filter(x=>x===d).length+a)/(w.length+10*a)};

export type DigitForecast=DigitScore & {probability:number;momentum3:number;positiveSteps:number;entropy:number;regime:EntropyRegime;sampleHits:number;sampleTrials:number};
type Frozen={probs:number[];expertProbs:Record<ExpertName,number[]>;top:number;momentumQualified:boolean;regime:EntropyRegime};
type Result={actual:number;top:number;predictedProbability:number;brier:number;logLoss:number;uniformLogLoss:number;qualified:boolean;regime:EntropyRegime};
export type IntelligenceAudit={trials:number;topHits:number;topHitRate:number;topLower95:number;brier:number;logLoss:number;uniformBrier:number;uniformLogLoss:number;digitTrials:number[];digitHits:number[];digitObserved:number[];weights:Record<ExpertName,number>;eligibleTrials:number;eligibleHits:number;eligibleLower95:number;regimes:Record<EntropyRegime,{trials:number;hits:number;rate:number}>};
export class NextTickIntelligence {
 private h:number[]=[];
 private trail:Record<number,number>[]=[];
 private pending:Frozen|null=null;
 private results:Result[]=[];
 private weights:Record<ExpertName,number>={frequency:.2,transition:.2,gap:.2,momentum:.2,entropy:.2};
 private losses:Record<ExpertName,number>={frequency:Math.log(10),transition:Math.log(10),gap:Math.log(10),momentum:Math.log(10),entropy:Math.log(10)};
 private latest:DigitForecast[]=[];
 reset(){this.h=[];this.trail=[];this.pending=null;this.results=[];this.latest=[];this.weights={frequency:.2,transition:.2,gap:.2,momentum:.2,entropy:.2};this.losses={frequency:Math.log(10),transition:Math.log(10),gap:Math.log(10),momentum:Math.log(10),entropy:Math.log(10)}}
 observe(actual:number):DigitForecast[]{
  if(!Number.isInteger(actual)||actual<0||actual>9)return this.latest;
  // IMPORTANT: all evaluation precedes recording the latest observed digit.
  if(this.pending){const p=this.pending;
   this.results.push({actual,top:p.top,predictedProbability:p.probs[actual],brier:p.probs.reduce((s,v,d)=>s+(v-Number(actual===d))**2,0),logLoss:-Math.log(Math.max(1e-8,p.probs[actual])),uniformLogLoss:Math.log(10),qualified:p.momentumQualified,regime:p.regime});
   if(this.results.length>2000)this.results.shift();
   for(const k of NAMES){const loss=-Math.log(Math.max(1e-8,p.expertProbs[k][actual]));this.losses[k]=.98*this.losses[k]+.02*loss;}
  }
  this.h=[...this.h.slice(-199),actual];
  const base=scoreDigits(this.h);if(base.length!==10){this.pending=null;this.latest=[];return []}
  const snapshot:Record<number,number>={};base.forEach(r=>snapshot[r.digit]=r.score);
  this.trail=[...this.trail.slice(-3),snapshot];
  const n=this.h.length,prev=this.h[n-1],e=entropy(this.h.slice(-25)),regime=regimeOf(e);
  const frequency=norm(Array.from({length:10},(_,d)=>.4*f(this.h,d,10,4)+.35*f(this.h,d,30,5)+.25*f(this.h,d,100,8)));
  const transition=norm(Array.from({length:10},(_,d)=>{
   let c1=0,s1=0,c2=0,s2=0;
   for(let i=0;i<n-1;i++)if(this.h[i]===prev){c1++;if(this.h[i+1]===d)s1++}
   for(let i=0;i<n-2;i++)if(this.h[i]===this.h[n-2]&&this.h[i+1]===prev){c2++;if(this.h[i+2]===d)s2++}
   // Prior smoothing avoids assigning high certainty to rare transitions.
   return .65*(s1+4)/(c1+40)+.35*(s2+3)/(c2+30);
  }));
  const gap=norm(Array.from({length:10},(_,d)=>{
   const ix=this.h.lastIndexOf(d),g=ix<0?30:n-1-ix;
   return .1+ .015*Math.exp(-Math.abs(Math.min(g,25)-6)/8);
  }));
  const momentum=Array.from({length:10},(_,d)=>{
   if(this.trail.length!==4)return {change:0,rises:0};
   const a=this.trail.map(x=>x[d]);return {change:a[3]-a[0],rises:[1,2,3].filter(i=>a[i]>a[i-1]).length};
  });
  const mom=softmax(momentum.map(x=>clamp(x.change,-12,12)+1.2*(x.rises-1.5)),12);
  // Entropy is a contextual feature, NOT evidence that any particular digit is due.
  const ent=norm(Array.from({length:10},(_,d)=> .1 + (1-e)*.15*(f(this.h,d,25,5)-.1)));
  const expertProbs:Record<ExpertName,number[]>={frequency,transition,gap,momentum:mom,entropy:ent};
  // Online weights use ONLY past realized outcomes, with conservative shrinkage.
  const adapted=softmax(NAMES.map(k=>-this.losses[k]),.12);
  const maturity=clamp(this.results.length/1000,0,.5);
  for(let i=0;i<NAMES.length;i++)this.weights[NAMES[i]]=(1-maturity)*.2+maturity*adapted[i];
  const raw=norm(Array.from({length:10},(_,d)=>NAMES.reduce((s,k)=>s+this.weights[k]*expertProbs[k][d],0)));
  // Shrink confidently toward the 10% null, preventing extreme noise-fit claims.
  const shrink=clamp(.55+.3*e,.55,.85);
  const probs=norm(raw.map(v=>shrink*.1+(1-shrink)*v));
  const selectedCounts=Array(10).fill(0), selectedHits=Array(10).fill(0);
  this.results.forEach(r=>{selectedCounts[r.top]++;if(r.top===r.actual)selectedHits[r.top]++});
  // Make all-ten model probability ranking drive selection; original V1 score
  // remains visible and usable as the user's threshold filter.
  this.latest=base.map(r=>({...r,probability:probs[r.digit],momentum3:momentum[r.digit].change,positiveSteps:momentum[r.digit].rises,entropy:e,regime,sampleHits:selectedHits[r.digit],sampleTrials:selectedCounts[r.digit]}))
   .sort((a,b)=>b.probability-a.probability||b.score-a.score||a.digit-b.digit);
  const top=this.latest[0];
  this.pending={probs:[...probs],expertProbs,top:top.digit,regime,momentumQualified:top.momentum3>0&&top.positiveSteps>=2};
  return this.latest;
 }
 getForecast(){return this.latest}
 getAudit():IntelligenceAudit{
  const r=this.results,n=r.length,hits=r.filter(x=>x.top===x.actual).length,eligible=r.filter(x=>x.qualified),eh=eligible.filter(x=>x.top===x.actual).length;
  const regimes={} as IntelligenceAudit['regimes'];
  for(const key of ['LOW','MID','HIGH'] as const){const subset=r.filter(x=>x.regime===key),h=subset.filter(x=>x.top===x.actual).length;regimes[key]={trials:subset.length,hits:h,rate:subset.length?h/subset.length:0}}
  return {trials:n,topHits:hits,topHitRate:n?hits/n:0,topLower95:wilson(hits,n),brier:n?avg(r.map(x=>x.brier)):0,logLoss:n?avg(r.map(x=>x.logLoss)):0,uniformBrier:.9,uniformLogLoss:Math.log(10),digitTrials:Array.from({length:10},(_,d)=>r.filter(x=>x.top===d).length),digitHits:Array.from({length:10},(_,d)=>r.filter(x=>x.top===d&&x.actual===d).length),digitObserved:Array.from({length:10},(_,d)=>r.filter(x=>x.actual===d).length),weights:{...this.weights},eligibleTrials:eligible.length,eligibleHits:eh,eligibleLower95:wilson(eh,eligible.length),regimes};
 }
 getLower95(){return this.getAudit().topLower95}
}
