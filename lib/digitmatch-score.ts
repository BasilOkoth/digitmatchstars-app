/** Execution scoring ported from TradeIn app/digit_score.py _stable_rows.
 * Shadow research (trend/trigger fusion) deliberately does not alter execution ranking.
 * Scores are relative rankings, NOT calibrated probabilities or trading edge.
 */
const freq=(h:number[],d:number,n:number)=> {const a=h.slice(-n);return a.length?a.filter(x=>x===d).length/a.length:0};
const entropy=(h:number[])=>{if(!h.length)return 0;return -Array.from({length:10},(_,d)=>freq(h,d,h.length)).reduce((s,p)=>s+(p>0?p*Math.log2(p):0),0)};
const gap=(h:number[],d:number)=>{for(let i=h.length-1;i>=0;i--)if(h[i]===d)return Math.min(50,h.length-1-i);return 50};
function transition(h:number[],d:number,order:1|2){let n=0,k=0;if(order===1){for(let i=0;i<h.length-1;i++){if(h[i]===h[h.length-1]){n++;if(h[i+1]===d)k++}}}else if(h.length>=3){for(let i=0;i<h.length-2;i++){if(h[i]===h[h.length-2]&&h[i+1]===h[h.length-1]){n++;if(h[i+2]===d)k++}}}return (k+1)/(n+10)}
export type DigitScore={digit:number;score:number;transition1:number;transition2:number};
export function scoreDigits(history:number[]):DigitScore[]{
 const h=history.filter(x=>Number.isInteger(x)&&x>=0&&x<=9).slice(-100);if(h.length<10)return [];
 const e10=entropy(h.slice(-10)),e25=entropy(h.slice(-25))/Math.log2(10);
 // Repetition patterns are already represented by causal transition counts.
 // Do not award a direct bonus simply because the candidate equals the latest observed digit.
 return Array.from({length:10},(_,d)=>{
 const f5=freq(h,d,5),f10=freq(h,d,10),f25=freq(h,d,25),f50=freq(h,d,50),f100=freq(h,d,100),g=gap(h,d),t1=transition(h,d,1),t2=transition(h,d,2);
 const moderate=Math.max(0,1-Math.abs(Math.min(g,16)-6)/10);const safe=f25<=.08&&e10<=2.5219280948873625?1:0;
 let score=42*(t1-.1)+24*(t2-.1)+16*(f5-.1)+12*(f10-.1)+7*(f25-.1)+4*(f50-.1)+2*(f100-.1)+8*(f5-f50)+5*(f10-f100)+2*moderate+safe;
 score*=Math.max(.55,1.15-.6*e25);return {digit:d,score,transition1:t1,transition2:t2};
 }).sort((a,b)=>b.score-a.score||b.transition2-a.transition2||b.transition1-a.transition1)
}
