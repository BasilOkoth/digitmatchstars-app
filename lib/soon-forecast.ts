/** Forward-only appearance audit. A SOON signal is not a one-tick win prediction. */
export const SOON_HORIZONS=[3,4,5,10] as const;
export type SoonHorizon=typeof SOON_HORIZONS[number];
type Pending={digit:number;horizon:SoonHorizon;remaining:number;hit:boolean};
export class SoonForecastAudit {
 private pending:Pending[]=[];
 private outcomes=new Map<SoonHorizon,{hits:number;trials:number}>();
 reset(){this.pending=[];this.outcomes.clear()}
 observe(actual:number){
  const next:Pending[]=[];
  for(const item of this.pending){
   const hit=item.hit||actual===item.digit;
   const remaining=item.remaining-1;
   if(remaining===0){const s=this.outcomes.get(item.horizon)??{hits:0,trials:0};s.trials++;if(hit)s.hits++;this.outcomes.set(item.horizon,s)}
   else next.push({...item,hit,remaining});
  }
  this.pending=next;
 }
 freeze(digit:number,horizon:SoonHorizon){this.pending.push({digit,horizon,remaining:horizon,hit:false});if(this.pending.length>1000)this.pending.shift()}
 stats(horizon:SoonHorizon){const s=this.outcomes.get(horizon)??{hits:0,trials:0};return {...s,benchmark:1-Math.pow(.9,horizon)}}
}
