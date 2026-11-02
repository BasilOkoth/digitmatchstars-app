'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {getLastDigit} from '@/lib/digit-stats';
import {scoreDigits} from '@/lib/digitmatch-score';
import {useExecutionTarget} from './digit-stats-bar';
import type {Tick,DerivWS} from '@deriv/core';

type Mode='IDLE'|'RUNNING'|'BUYING'|'SETTLING'|'WIN'|'MAX_TRADES'|'MAX_LOSS'|'UNCERTAIN'|'STOPPED';
type Outcome={id:number;digit:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
type MomentumTrade = {recordType:'TRADE';contractId:number;accountId:string;symbol:string;timestamp:string;targetDigit:number;score:number;momentum3:number;positiveSteps:number;momentumRising:boolean;threshold:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
const amount=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
function tone(kind:'buy'|'win'|'loss'){
 try{const A=window.AudioContext;const ctx=new A();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.type=kind==='win'?'sine':'triangle';osc.frequency.value=kind==='win'?880:kind==='buy'?650:250;gain.gain.value=.065;osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+(kind==='win'?.42:.15));osc.onended=()=>{void ctx.close()}}catch{/* audio unsupported */}
}
export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string}){
 const {setTarget} = useExecutionTarget();
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('15.01');
 const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
 const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
 const scoreHistoryRef=useRef<Record<number,number>[]>([]);
 const outstanding=useRef(new Map<number,{digit:number;stake:number;tickEpoch:number}>());
 const reservedStake=useRef(0);
 const [outstandingCount,setOutstandingCount]=useState(0);
 const confirmedLosses=useRef(0);
 const [earlySignal,setEarlySignal]=useState('');
 const [topMomentum,setTopMomentum]=useState<number|null>(null);
 const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
 const valid=Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0;
 const next=amount(Number(base)*Math.pow(Number(factor),confirmedLosses.current));const scopeKey=`${accountId}:${symbol}`;
 const [latency,setLatency]=useState<{quote:number;buy:number;settlement:number}|null>(null);
 const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
 const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
 const stop=useCallback(()=>{halt.current=true;active.current=false;setTarget(null);setLockedDigit(null);lockedRef.current=null;setMode(m=>m==='RUNNING'?'STOPPED':m)},[setTarget]);
 useEffect(()=>{if(scope.current!==scopeKey){scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];setTopMomentum(null);lockedRef.current=null;countRef.current=0;lossBlockRef.current=0;pnlRef.current=0;pending.current=false;lastTickKey.current='';setHistory([]);setScores([]);setLockedDigit(null);setTarget(null);setCount(0);setPnl(0);setLossBlock(0);setMode(outstanding.current.size?'UNCERTAIN':'IDLE');setLastOutcome(null);if(!outstanding.current.size)setErr('')}},[scopeKey,setTarget]);
 const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number)=>{
  if(!ws||!accountId||pending.current||halt.current||outstanding.current.size>=2)return;
  // Pending buy locks only the quote/purchase sequence. Settlement is independent.
  pending.current=true;setMode('BUYING');let contractId:number|undefined;let purchaseAttempted=false;
  // Reserve this risk immediately so a later tick cannot exceed the cycle budget.
  reservedStake.current+=stake;
  try{
   if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
   const quoteStart=performance.now();
   const quote=await ws.send<any>({proposal:1,amount:stake,basis:'stake',contract_type:'DIGITMATCH',currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,barrier:String(predicted)});
   const quoteMs=Math.round(performance.now()-quoteStart);
   const proposalId=quote?.proposal?.id;const ask=Number(quote?.proposal?.ask_price);
   if(!proposalId||!Number.isFinite(ask)||ask<=0||ask>stake*1.05)throw new Error('Quote invalid or stale');
   if(halt.current)return;
   purchaseAttempted=true;
   const buyStart=performance.now();
   const bought=await ws.send<any>({buy:String(proposalId),price:ask});
   setLatency({quote:quoteMs,buy:Math.round(performance.now()-buyStart),settlement:0});
   contractId=Number(bought?.buy?.contract_id);
   if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
   countRef.current++;setCount(countRef.current);play('buy');
   // Keep the risk reserved and register the contract BEFORE releasing the buy lock.
   reservedStake.current=amount(reservedStake.current-stake+ask);
   outstanding.current.set(contractId,{digit:predicted,stake:ask,tickEpoch});
   setOutstandingCount(outstanding.current.size);
   setMode('SETTLING');
   const id=contractId;
   // Background monitor; the tick callback is allowed to initiate another buy.
   void (async()=>{
    let unsubscribe:(()=>Promise<void>)|undefined;
    const settlementStart=performance.now();
    try{
     const settle=await new Promise<any>(async(resolve,reject)=>{
      let done=false;let pollTimer:ReturnType<typeof setInterval>|undefined;
      const timeout=setTimeout(()=>finish(null,new Error(`Unconfirmed contract ${id}; reconciliation required`)),45000);
      function finish(c:any,error?:Error){if(done)return;done=true;clearTimeout(timeout);if(pollTimer)clearInterval(pollTimer);if(error)reject(error);else resolve(c)}
      const handle=(frame:Record<string,unknown>)=>{const c=(frame as any).proposal_open_contract;if(Number(c?.contract_id)!==id)return;if(c.is_sold||c.status==='won'||c.status==='lost')finish(c)};
      try{const sub=await ws.subscribe({proposal_open_contract:1,contract_id:id},handle);unsubscribe=sub.unsubscribe;if(done)void sub.unsubscribe()}catch{
       const poll=async()=>{try{handle(await ws.send<any>({proposal_open_contract:1,contract_id:id}))}catch{}};
       pollTimer=setInterval(()=>void poll(),1200);void poll();
      }
     });
     const payout=Number(settle.sell_price??settle.payout??0);const buyPrice=Number(settle.buy_price??ask);
     if(!Number.isFinite(payout)||!Number.isFinite(buyPrice))throw new Error('Settlement amounts unavailable');
     setLatency(old=>old?{...old,settlement:Math.round(performance.now()-settlementStart)}:null);
     const profit=amount(payout-buyPrice);pnlRef.current=amount(pnlRef.current+profit);setPnl(pnlRef.current);
     const win=profit>0;setLastOutcome({id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'});play(win?'win':'loss');
     const journalRow:MomentumTrade={recordType:'TRADE',contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,momentumRising:signal.momentum3>0&&signal.positiveSteps>=2,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'};
     try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:MomentumTrade)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
     outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);
     if(win){halt.current=true;active.current=false;setTarget(null);setMode('WIN')}
     else {
      confirmedLosses.current++;
      if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}
      else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){halt.current=true;active.current=false;setMode('MAX_LOSS')}
      else if(active.current&&!halt.current)setMode(outstanding.current.size?'SETTLING':'RUNNING');
     }
    }catch(e){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv before restarting.`)}
    finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size)}
   })();
  }catch(e){halt.current=true;active.current=false;
   // Uncertain buy: retain reservation. Do not retry or initiate more purchases.
   if(purchaseAttempted){setMode('UNCERTAIN');setErr(`Purchase status unknown: ${String(e)}. Reconcile in Deriv.`)}
   else{reservedStake.current=Math.max(0,amount(reservedStake.current-stake));setMode('STOPPED');setErr(`No trade was purchased: ${String(e)}`)}
  }finally{pending.current=false}
 },[ws,accountId,symbol,limit,maxLoss,play,setTarget]);
 const execRef=useRef(execute);useEffect(()=>{execRef.current=execute},[execute]);
 // Process the live WebSocket frame synchronously, BEFORE React's render cycle.
 // Reuse the existing market subscription; do not create a duplicate tick feed.
 const tickSettings=useRef({pipSize,limit,threshold,base,factor,maxLoss,isConnected,accountId,symbol});
 tickSettings.current={pipSize,limit,threshold,base,factor,maxLoss,isConnected,accountId,symbol};
 useEffect(()=>{
  if(!ws)return;
  return ws.onMessage((frame:Record<string,unknown>)=>{
   if(frame.msg_type!=='tick'||!frame.tick)return;
   const tick=frame.tick as any;
   const settings=tickSettings.current;
   if(tick.symbol!==settings.symbol||!Number.isFinite(Number(tick.quote)))return;
   const key=`${tick.epoch}:${tick.quote}`;
   if(lastTickKey.current===key)return;
   lastTickKey.current=key;
   const digit=getLastDigit(Number(tick.quote),Number.isInteger(tick.pip_size)?tick.pip_size:settings.pipSize);
   histRef.current=[...histRef.current.slice(-99),digit];
   // Early observation ONLY: a matching market tick is not a verified contract WIN.
   const matches=[...outstanding.current.entries()].filter(([,v])=>v.digit===digit&&Number(tick.epoch)>v.tickEpoch);
   setEarlySignal(matches.length?`Possible match · ${matches.map(([id])=>'#'+id).join(', ')}`:'');
   const ranking=scoreDigits(histRef.current);scoreRef.current=ranking;
   // Freeze all ten scores at each distinct tick. Evaluate momentum only using
   // score history that PRECEDES the current trade decision.
   if(ranking.length===10){
     const snapshot:Record<number,number>={};
     ranking.forEach(r=>{snapshot[r.digit]=r.score});
     scoreHistoryRef.current=[...scoreHistoryRef.current.slice(-3),snapshot];
   }
   const top=ranking[0];
   const hist=scoreHistoryRef.current;
   // Three-tick net momentum; require at least two positive steps, rather
   // than accepting a brief rebound in an otherwise weakening score.
   const trail=top && hist.length>=4 ? hist.slice(-4).map(row=>row[top.digit]) : [];
   const momentum=trail.length===4 ? trail[3]-trail[0] : null;
   const rises=trail.length===4 ? trail.slice(1).filter((v,i)=>v>trail[i]).length : 0;
   const rising=momentum!==null && momentum>0 && rises>=2;
   // Render-only state; purchase scheduling does not wait for it.
   setHistory(histRef.current);setScores(ranking);setTopMomentum(momentum);
   if(!active.current||halt.current||pending.current||outstanding.current.size>=2||!ranking.length||!settings.accountId||!settings.isConnected)return;
   if(countRef.current>=Number(settings.limit)){halt.current=true;active.current=false;setMode('MAX_TRADES');return}
   if(top.score<Number(settings.threshold) || !rising)return;
   const target=top.digit;
   const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),confirmedLosses.current));
   if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
    stop();setMode('MAX_LOSS');return;
   }
   lockedRef.current=target;setLockedDigit(target);setTarget(target);
   // Lock purchase immediately; no React rerender or effect scheduling required.
   void execRef.current(target,stake,{score:top.score,momentum3:momentum!,positiveSteps:rises,threshold:Number(settings.threshold)},Number(tick.epoch));
  });
 },[ws,stop,setTarget]);

 function start(){
  if(!valid||!accountId||!isConnected||!ws||pending.current||active.current||outstanding.current.size)return;
  const acc=real?'REAL MONEY':'DEMO';
  if(real&&!window.confirm(`REAL MONEY: Automated DigitMatch on ${symbol}, with up to TWO unsettled contracts at once. Up to ${limit} purchases, progression ${factor}×, maximum cycle loss $${maxLoss}. Confirm you accept overlapping real-money exposure.`))return;
  if(!window.confirm(`Start ${acc} automatic cycle? Contract: 1-tick DigitMatch. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
  // Must begin a fresh cycle. Uncertain purchases cannot be reset with this control.
  if(mode==='UNCERTAIN'||outstanding.current.size>0)return;
  countRef.current=0;pnlRef.current=0;confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTarget(null);setLastOutcome(null);setErr('');halt.current=false;active.current=true;setMode('RUNNING');if(sound)tone('buy');
 }
 return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Auto Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pending.current} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top digit',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-1 text-[11px] font-semibold" aria-live="polite">
    <span className={topMomentum!==null&&topMomentum>0?'text-emerald-400':'text-rose-400'}>
      V1 momentum: {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)} / 3 ticks`}
    </span>
    <span className="ml-2 text-slate-400">Entry requires score threshold + rising trend (2 of 3 increases).</span>
  </div>
  {latency&&<div className="mt-1 text-[10px] text-slate-400">Quote {latency.quote}ms · Buy {latency.buy}ms · Settlement {latency.settlement||'…'}ms</div>}
  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300"><span>Contract target: {pending.current ? lockedDigit ?? '—' : '—'}</span><span>Outstanding: {outstandingCount}/2</span><span className="text-amber-300">{earlySignal}</span><span>Sample: {history.length} ticks</span></div>
  <div className="mt-2 flex items-center gap-2">
    <button
      disabled={!active.current && (!valid||!accountId||!isConnected||pending.current||outstandingCount>0||mode==='UNCERTAIN')}
      onClick={() => { if(active.current) stop(); else start(); }}
      className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}
    >{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
    <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
  </div>
  {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Verified contract #{lastOutcome.id}</span></div>}
  {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}

 </div></section>
}
