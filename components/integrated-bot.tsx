'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {getLastDigit} from '@/lib/digit-stats';
import {scoreDigits} from '@/lib/digitmatch-score';
import type {Tick,DerivWS} from '@deriv/core';

type Mode='IDLE'|'RUNNING'|'BUYING'|'SETTLING'|'WIN'|'MAX_TRADES'|'MAX_LOSS'|'UNCERTAIN'|'STOPPED';
type Outcome={id:number;digit:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
const amount=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
function tone(kind:'buy'|'win'|'loss'){
 try{const A=window.AudioContext;const ctx=new A();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.type=kind==='win'?'sine':'triangle';osc.frequency.value=kind==='win'?880:kind==='buy'?650:250;gain.gain.value=.065;osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+(kind==='win'?.42:.15));osc.onended=()=>{void ctx.close()}}catch{/* audio unsupported */}
}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string}){
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('15.01');
 const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
 const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
 const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
 const valid=Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0;
 const next=amount(Number(base)*Math.pow(Number(factor),count));const scopeKey=`${accountId}:${symbol}`;
 const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
 const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
 const stop=useCallback(()=>{halt.current=true;active.current=false;setMode(m=>m==='RUNNING'?'STOPPED':m)},[]);
 useEffect(()=>{if(scope.current!==scopeKey){scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];lockedRef.current=null;countRef.current=0;lossBlockRef.current=0;pnlRef.current=0;pending.current=false;lastTickKey.current='';setHistory([]);setScores([]);setLockedDigit(null);setCount(0);setPnl(0);setLossBlock(0);setMode('IDLE');setLastOutcome(null);setErr('')}},[scopeKey]);
 const execute=useCallback(async(predicted:number,stake:number)=>{
  if(!ws||!accountId||pending.current||halt.current)return;
  pending.current=true;setMode('BUYING');let contractId:number|undefined;let purchaseAttempted=false;
  try{
   // Proposal is for the *locked scoring digit*, never the manually selected digit.
   if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
   const quote=await ws.send<any>({proposal:1,amount:stake,basis:'stake',contract_type:'DIGITMATCH',currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,barrier:String(predicted)});
   const proposalId=quote?.proposal?.id;const ask=Number(quote?.proposal?.ask_price);
   if(!proposalId||!Number.isFinite(ask)||ask<=0||ask>stake*1.05)throw new Error('Quote invalid or stale');
   if(halt.current)return;
   // Send exactly one buy. Any unknown outcome is a hard stop; never retry blindly.
   purchaseAttempted=true;
   const bought=await ws.send<any>({buy:String(proposalId),price:ask});
   contractId=Number(bought?.buy?.contract_id);
   if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
   countRef.current+=1;setCount(countRef.current);play('buy');setMode('SETTLING');
   let settle:any=null;
   for(let tries=0;tries<35;tries++){
    await sleep(1200);
    const resp=await ws.send<any>({proposal_open_contract:1,contract_id:contractId});
    const c=resp?.proposal_open_contract;
    if(c?.is_sold||c?.status==='won'||c?.status==='lost'){settle=c;break}
   }
   if(!settle)throw new Error(`Contract ${contractId} not confirmed settled; blocked to avoid duplicate trades`);
   const payout=Number(settle.sell_price??settle.payout??0);const buyPrice=Number(settle.buy_price??ask);
   if(!Number.isFinite(payout)||!Number.isFinite(buyPrice))throw new Error('Settlement amounts unavailable');
   const profit=amount(payout-buyPrice);pnlRef.current=amount(pnlRef.current+profit);setPnl(pnlRef.current);
   const win=profit>0;setLastOutcome({id:contractId,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'});play(win?'win':'loss');
   if(win){halt.current=true;active.current=false;setMode('WIN')}
   else{
    lossBlockRef.current++;setLossBlock(lossBlockRef.current);
    if(lossBlockRef.current>=3){lockedRef.current=null;setLockedDigit(null);lossBlockRef.current=0;setLossBlock(0)}
    if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}
    else if(-pnlRef.current>=Number(maxLoss)){halt.current=true;active.current=false;setMode('MAX_LOSS')}
    else setMode('RUNNING');
   }
  }catch(e){halt.current=true;active.current=false;
   if(purchaseAttempted){setMode('UNCERTAIN');setErr(`${String(e)}${contractId?` — contract ${contractId}`:''}`)}
   else{setMode('STOPPED');setErr(`No trade was purchased: ${String(e)}`)}
  }finally{pending.current=false}
 },[ws,accountId,symbol,limit,maxLoss,play]);
 const execRef=useRef(execute);useEffect(()=>{execRef.current=execute},[execute]);
 useEffect(()=>{
  if(!currentTick||!Number.isFinite(currentTick.quote))return;
  const key=String((currentTick as any).epoch??currentTick.quote)+':'+String(currentTick.quote);
  if(lastTickKey.current===key)return;lastTickKey.current=key;
  const d=getLastDigit(currentTick.quote,pipSize);histRef.current=[...histRef.current.slice(-99),d];
  const ranking=scoreDigits(histRef.current);scoreRef.current=ranking;setHistory(histRef.current);setScores(ranking);
  if(!active.current||halt.current||pending.current||ranking.length===0||!ws||!accountId||!isConnected)return;
  if(countRef.current>=Number(limit)){stop();setMode('MAX_TRADES');return}
  let digit=lockedRef.current;
  if(digit===null){if(ranking[0].score<Number(threshold))return;digit=ranking[0].digit;lockedRef.current=digit;setLockedDigit(digit)}
  const stake=amount(Number(base)*Math.pow(Number(factor),countRef.current));
  // A single trade must fit remaining cycle-loss budget, not just next stake.
  if(!Number.isFinite(stake)||stake<=0||stake+Math.max(0,-pnlRef.current)>Number(maxLoss)){stop();setMode('MAX_LOSS');return}
  void execRef.current(digit,stake);
 },[currentTick,pipSize,ws,accountId,isConnected,limit,threshold,base,factor,maxLoss,stop]);
 function start(){
  if(!valid||!accountId||!isConnected||!ws||pending.current||active.current)return;
  const acc=real?'REAL MONEY':'DEMO';
  if(real&&!window.confirm(`REAL MONEY: Start automated DigitMatch trading on ${symbol}? Up to ${limit} trades, stake progression ${factor}×, maximum cycle loss $${maxLoss}. You may lose real funds.`))return;
  if(!window.confirm(`Start ${acc} automatic cycle? Contract: 1-tick DigitMatch. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
  // Must begin a fresh cycle. Uncertain purchases cannot be reset with this control.
  if(mode==='UNCERTAIN')return;
  countRef.current=0;pnlRef.current=0;lossBlockRef.current=0;lockedRef.current=null;setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setLastOutcome(null);setErr('');halt.current=false;active.current=true;setMode('RUNNING');if(sound)tone('buy');
 }
 return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Auto Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pending.current} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top digit',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300"><span>Locked: {lockedDigit??'—'}</span><span>Block losses: {lossBlock}/3</span><span>Sample: {history.length} ticks</span></div>
  <div className="mt-2 flex items-center gap-2">
    <button
      disabled={!active.current && (!valid||!accountId||!isConnected||pending.current||mode==='UNCERTAIN')}
      onClick={() => { if(active.current) stop(); else start(); }}
      className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}
    >{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
    <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
  </div>
  {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Verified contract #{lastOutcome.id}</span></div>}
  {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}

 </div></section>
}
