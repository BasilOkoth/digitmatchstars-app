'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {getLastDigit} from '@/lib/digit-stats';
import {scoreDigits} from '@/lib/digitmatch-score';
import {useExecutionTarget} from './digit-stats-bar';
import type {Tick,DerivWS} from '@deriv/core';

type Mode='IDLE'|'RUNNING'|'BUYING'|'SETTLING'|'WIN'|'MAX_TRADES'|'MAX_LOSS'|'UNCERTAIN'|'STOPPED';
type Outcome={id:number;digit:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS';expiryDigit:number|null;expiryEpoch:number|null;signalEpoch:number;purchaseEpoch:number|null};
type Strategy='DYNAMIC'|'MOMENTUM_LOCK';
type MomentumTrade = {strategy?:Strategy;lockTick?:number;lockDuration?:number;signalEpoch?:number;purchaseEpoch?:number|null;expiryEpoch?:number|null;expiryDigit?:number|null;signalSequence?:number;signalToSubmitMs?:number;buyAcknowledgmentMs?:number;entryEpoch?:number|null;entryDigit?:number|null;entrySpot?:string|null;exitSpot?:string|null;recordType:'TRADE';contractId:number;accountId:string;symbol:string;timestamp:string;targetDigit:number;score:number;momentum3:number;positiveSteps:number;momentumRising:boolean;threshold:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
// Prefer the current Deriv spot fields. When Deriv returns a numeric spot,
// the symbol's pip precision restores trailing zeroes consistently.
const spotDigit=(spot:unknown,precision:number):number|null=>{
 if(spot===null||spot===undefined||spot==='')return null;
 const n=Number(spot);
 return Number.isFinite(n)&&Number.isInteger(precision)&&precision>=0&&precision<=12
   ?getLastDigit(n,precision):null;
};
const expiryDigitOf=(c:any,precision:number):number|null=>
 spotDigit(c?.exit_spot??c?.exit_tick??c?.exit_tick_display_value,precision);
const amount=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
function tone(kind:'buy'|'win'|'loss'){
 try{const A=window.AudioContext;const ctx=new A();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.type=kind==='win'?'sine':'triangle';osc.frequency.value=kind==='win'?880:kind==='buy'?650:250;gain.gain.value=.065;osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+(kind==='win'?.42:.15));osc.onended=()=>{void ctx.close()}}catch{/* audio unsupported */}
}
export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string}){
 const {setTarget} = useExecutionTarget();
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
 const [strategy,setStrategy]=useState<Strategy>('DYNAMIC');const [lockDuration,setLockDuration]=useState('5');
 const lockRef=useRef<{digit:number;elapsed:number;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number}}|null>(null);
 const [lockPosition,setLockPosition]=useState(0);
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('6');const [minMomentum,setMinMomentum]=useState('0');
 const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
 const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
 const scoreHistoryRef=useRef<Record<number,number>[]>([]);
 const outstanding=useRef(new Map<number,{digit:number;stake:number;signalEpoch:number;purchaseEpoch:number|null;}>());
 const reservedStake=useRef(0);
 // A matching live last digit is only an observation, not a verified WIN.
 // Hold all new purchases until every observed matching open contract settles.
 const matchHoldIds=useRef(new Set<number>());
 const [matchHoldCount,setMatchHoldCount]=useState(0);
 const [entryStatus,setEntryStatus]=useState('Waiting for signal');
 // A match can arrive while a buy request is awaiting its acknowledgement.
 // Once that purchase gets its contract ID, attach the match hold to it.
 const pendingMatchObserved=useRef(false);
 // Hold the stop-after-win state while other already-purchased contracts settle.
 const winConfirmed=useRef(false);
 // Record the stream at ingress, independently of React rendering and settlement.
 // An expiry can correspond to ANY observed post-buy tick, not necessarily the first.
 const streamTicks=useRef<Array<{epoch:number;digit:number;quote:number;receivedAt:number}>>([]);
 const tickStats=useRef({received:0,outOfOrder:0,duplicates:0,staleQuotes:0});
 // A monotonic local sequence is essential: multiple market ticks may share one epoch second.
 const tickSequence=useRef(0);
 // Enforce one submitted order per unique tick, in acknowledged purchase order.
 const lastBuySignalSequence=useRef(0);
 const lastBuyAcknowledgedAtSequence=useRef(0);
 // De-duplicate delayed copies from the raw and useTicks fallback feeds.
 const seenTickKeys=useRef(new Set<string>());
 const seenTickOrder=useRef<string[]>([]);
 const tickCadence=useRef<{lastArrival:number|null;intervalMs:number|null}>({lastArrival:null,intervalMs:null});
 const [cadenceLabel,setCadenceLabel]=useState('Measuring tick interval');
 const [streamStatus,setStreamStatus]=useState('Tick stream warming up');
 // A possible post-buy match pauses all NEW purchases synchronously until
 // Deriv settles that particular contract. This is not a confirmed WIN.
 const [outstandingCount,setOutstandingCount]=useState(0);
 const confirmedLosses=useRef(0);
 const [syncStatus,setSyncStatus]=useState('Waiting for a purchase');
 const [topMomentum,setTopMomentum]=useState<number|null>(null);
 const [expiryStrength,setExpiryStrength]=useState<number|null>(null);
 const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
 const valid=Number.isInteger(Number(lockDuration))&&Number(lockDuration)>=1&&Number(lockDuration)<=30&&Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0;
 const next=amount(Number(base)*Math.pow(Number(factor),confirmedLosses.current));const scopeKey=`${accountId}:${symbol}`;
 const [latency,setLatency]=useState<{quote:number;buy:number;settlement:number}|null>(null);
 const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
 const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
 const stop=useCallback(()=>{halt.current=true;active.current=false;setTarget(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setMode(m=>m==='RUNNING'?'STOPPED':m)},[setTarget]);
 useEffect(()=>{if(scope.current!==scopeKey){scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];lockRef.current=null;setLockPosition(0);setTopMomentum(null);setExpiryStrength(null);lockedRef.current=null;countRef.current=0;lossBlockRef.current=0;pnlRef.current=0;pending.current=false;lastTickKey.current='';matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');setHistory([]);setScores([]);setLockedDigit(null);setTarget(null);setCount(0);setPnl(0);setLossBlock(0);setMode(outstanding.current.size?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;if(!outstanding.current.size)setErr('')}},[scopeKey,setTarget]);
 const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,signalTickMatch:boolean)=>{
  if(!ws||!accountId||pending.current||halt.current||matchHoldIds.current.size>0||outstanding.current.size>=4)return;
  // Never replay ticks skipped while a previous buy was in flight.
  if(signalSequence<=lastBuySignalSequence.current || signalSequence<=lastBuyAcknowledgedAtSequence.current)return;
  // Pending buy locks only the quote/purchase sequence. Settlement is independent.
  pending.current=true;setMode('BUYING');let contractId:number|undefined;let purchaseAttempted=false;
  // Reserve this risk immediately so a later tick cannot exceed the cycle budget.
  reservedStake.current+=stake;
  try{
   if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
   // Both Demo and Real use the same one-request Deriv buy. One tick can
   // trigger at most one irreversible purchase; the WS acknowledgement is
   // never interpreted as an already-settled WIN.
   if(tickSequence.current!==signalSequence || signalSequence<=lastBuySignalSequence.current || signalSequence<=lastBuyAcknowledgedAtSequence.current || halt.current || matchHoldIds.current.size>0){
     tickStats.current.staleQuotes++;
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     setMode(outstanding.current.size?'SETTLING':'RUNNING');
     return;
   }
   // Reserve this tick before an irreversible buy request.
   // The next request must be driven by a *later tick*, not a queued signal.
   lastBuySignalSequence.current=signalSequence;
   pendingMatchObserved.current=false;
   purchaseAttempted=true;
   const buyStart=performance.now();
   const signalToSubmitMs=Math.max(0,Math.round(buyStart-signalReceivedAt));
   const bought=await ws.send<any>({
     buy:'1', price:amount(stake*1.05),
     parameters:{amount:stake,basis:'stake',contract_type:'DIGITMATCH',
       currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,
       barrier:String(predicted)},
   });
   const buyMs=Math.round(performance.now()-buyStart);
   const acknowledgedAt=performance.now();
   const quoteMs=0;
   const paid=Number(bought?.buy?.buy_price);
   const ask=Number.isFinite(paid)&&paid>0?paid:stake;
   setLatency({quote:quoteMs,buy:buyMs,settlement:0});
   // Purchase acknowledgement is the earliest safe point to associate subsequent market ticks.
   const purchaseEpoch=Number(bought?.buy?.start_time ?? bought?.buy?.purchase_time ?? bought?.buy?.transaction_time);
   const acknowledgedEpoch=Number.isFinite(purchaseEpoch)&&purchaseEpoch>0?purchaseEpoch:null;
   contractId=Number(bought?.buy?.contract_id);
   if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
   // Only ticks processed AFTER this acknowledgement may trigger buy #2.
   lastBuyAcknowledgedAtSequence.current=tickSequence.current;
   if(!Number.isFinite(ask)||ask<=0||ask>stake*1.05+0.001)throw new Error('Confirmed purchase price exceeds maximum; reconcile with Deriv');
   countRef.current++;setCount(countRef.current);play('buy');
   // Keep the risk reserved and register the contract BEFORE releasing the buy lock.
   reservedStake.current=amount(reservedStake.current-stake+ask);
   outstanding.current.set(contractId,{digit:predicted,stake:ask,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});
   if(pendingMatchObserved.current || signalTickMatch){
     // A signal-tick match in either strategy is purchased immediately.
     // Block further purchases until the acknowledged contract settles.
     matchHoldIds.current.add(contractId);
     setMatchHoldCount(matchHoldIds.current.size);
     // The accepted contract now owns the hold; clear the transient pending flag.
     pendingMatchObserved.current=false;
   }
   setSyncStatus(`Bought #${contractId} · target ${predicted} · signal ${tickEpoch} · ${acknowledgedEpoch===null?'purchase time unavailable':`buy ${acknowledgedEpoch}`}`);
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
     const win=profit>0;
     const expiryDigit=expiryDigitOf(settle,tickSettings.current.pipSize);
     const entrySpot=settle.entry_spot??settle.entry_tick??null;
     const entryEpochRaw=Number(settle.entry_spot_time??settle.entry_tick_time);
     const entryEpoch=Number.isFinite(entryEpochRaw)&&entryEpochRaw>0?entryEpochRaw:null;
     const entryDigit=spotDigit(entrySpot,tickSettings.current.pipSize);
     const expiryEpochRaw=Number(settle.exit_spot_time??settle.exit_tick_time);
     const expiryEpoch=Number.isFinite(expiryEpochRaw)&&expiryEpochRaw>0?expiryEpochRaw:null;
     // Do not claim that the browser's first post-buy tick must be the
     // contract expiry tick. Compare timestamps before comparing digits.
     // Compare the authoritative expiry with the *matching epoch* from the
     // raw stream ring buffer, not merely the first tick after buy.
     const alignedTicks=expiryEpoch===null?[]:streamTicks.current.filter(t=>t.epoch===expiryEpoch);
     const aligned=alignedTicks.length===1?alignedTicks[0]:null;
     const observationResult=aligned
       ? ` · streamed expiry-epoch digit ${aligned.digit}${aligned.digit===expiryDigit?' (aligned)':' (disagrees: verify pip precision)'}`
       : ` · ${alignedTicks.length>1?'multiple same-second ticks':'expiry tick not in browser buffer'} (no browser match inferred)`;
     setSyncStatus(`Contract #${id}: target ${predicted} · expiry ${expiryDigit??'unknown'} at ${expiryEpoch??'unknown'} · ${win?'WIN':'LOSS'} (Deriv verified)${observationResult}`);
     setLastOutcome(old=>old?.outcome==='WIN'&&!win?old:{id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS',expiryDigit,expiryEpoch,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});play(win?'win':'loss');
     const journalRow:MomentumTrade={signalSequence,signalToSubmitMs,buyAcknowledgmentMs:Math.round(acknowledgedAt-buyStart),entryEpoch,entryDigit,entrySpot:entrySpot===null?null:String(entrySpot),exitSpot:settle.exit_spot===undefined?null:String(settle.exit_spot),strategy:entryStrategy,lockTick,lockDuration:lockWindow,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch,expiryEpoch,expiryDigit,recordType:'TRADE',contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,momentumRising:signal.momentum3>0&&signal.positiveSteps>=2,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'};
     try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:MomentumTrade)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
     // The corresponding Deriv settlement, not another browser tick, releases
     // this contract's match hold. Other matching unsettled contracts still hold.
     matchHoldIds.current.delete(id);
     setMatchHoldCount(matchHoldIds.current.size);
     if(!winConfirmed.current && matchHoldIds.current.size===0)setEntryStatus('Ready for next qualifying tick');
     outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);
     if(win){winConfirmed.current=true;halt.current=true;active.current=false;setTarget(null);setMode('WIN')}
     else {
      confirmedLosses.current++;
      if(winConfirmed.current){setMode('WIN')}
      else if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}
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
  }finally{pendingMatchObserved.current=false;pending.current=false}
 },[ws,accountId,symbol,limit,maxLoss,play,setTarget]);
 const execRef=useRef(execute);useEffect(()=>{execRef.current=execute},[execute]);
 // Process the live WebSocket frame synchronously, BEFORE React's render cycle.
 // Reuse the existing market subscription; do not create a duplicate tick feed.
 const tickSettings=useRef({pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration});
 tickSettings.current={pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration};
 // A single processing path handles both the raw WebSocket callback and the
 // already-subscribed useTicks market feed. The market feed is a fallback when
 // onMessage receives only an initial snapshot rather than subscription updates.
 // Deduplication is shared, so an arrival through both paths is processed once.
 const processMarketTick=useCallback((tick:any)=>{
   const settings=tickSettings.current;
   if(tick.symbol && tick.symbol!==settings.symbol)return;
   if(!settings.symbol || !Number.isFinite(Number(tick.quote)))return;
   const epoch=Number(tick.epoch);
   if(!Number.isFinite(epoch))return;
   // Same identity across raw frames and useTicks (which may omit tick.id).
   const key=`${epoch}:${Number(tick.quote)}`;
   // A delayed duplicate tick from the other source must not be traded again.
   if(seenTickKeys.current.has(key)){tickStats.current.duplicates++;return}
   const prevEpoch=Number(lastTickKey.current.split(':')[0]);
   if(lastTickKey.current && Number.isFinite(prevEpoch) && epoch<prevEpoch){
     tickStats.current.outOfOrder++;return;
   }
   lastTickKey.current=key;
   seenTickKeys.current.add(key);
   seenTickOrder.current.push(key);
   if(seenTickOrder.current.length>256){
     const expired=seenTickOrder.current.shift();
     if(expired)seenTickKeys.current.delete(expired);
   }
   const digit=getLastDigit(Number(tick.quote),Number.isInteger(tick.pip_size)?tick.pip_size:settings.pipSize);
   const receivedAt=performance.now();
   const previousArrival=tickCadence.current.lastArrival;
   if(previousArrival!==null){
     const interval=receivedAt-previousArrival;
     if(interval>0&&interval<15000){
       const prev=tickCadence.current.intervalMs;
       tickCadence.current.intervalMs=prev===null?interval:(prev*0.75+interval*0.25);
     }
   }
   tickCadence.current.lastArrival=receivedAt;
   const sequence=++tickSequence.current;
   streamTicks.current=[...streamTicks.current.slice(-99),{epoch,digit,quote:Number(tick.quote),receivedAt}];
   tickStats.current.received++;
   if(tickStats.current.received%5===0){
     const ms=tickCadence.current.intervalMs;
     setCadenceLabel(ms===null?'Measuring tick interval':`${(ms/1000).toFixed(2)}s/tick · ${(1000/ms).toFixed(2)} ticks/s`);
     setStreamStatus(`Stream ${tickStats.current.received} ticks · duplicates ${tickStats.current.duplicates} · out of order ${tickStats.current.outOfOrder} · stale quotes ${tickStats.current.staleQuotes}`);
   }
   histRef.current=[...histRef.current.slice(-99),digit];
   // Check the ACTUAL current market digit against open contract targets.
   // Freeze the next buy synchronously, before this tick can trigger trading.
   // The observed match is not a WIN; only Deriv settlement can resolve it.
   // Compare ONLY the currently executing/locked target. Previously any old
   // outstanding target could freeze the whole cycle even after V1 switched.
   // When there is no live lock, a historical contract match is not a new
   // reason to freeze a different target's signal.
   const currentLockedTarget=settings.strategy==='MOMENTUM_LOCK'
     ? lockRef.current?.digit ?? null
     : lockedRef.current;
   let foundMatch=false;
   if(currentLockedTarget!==null && digit===currentLockedTarget){
     for(const [id,contract] of outstanding.current){
       if(contract.digit===currentLockedTarget){
         matchHoldIds.current.add(id);
         foundMatch=true;
       }
     }
     if(pending.current){
       pendingMatchObserved.current=true;
       foundMatch=true;
     }
   }
   if(foundMatch){
     setMatchHoldCount(matchHoldIds.current.size || 1);
     setEntryStatus('Matching tick seen · awaiting settlement');
   }
   const ranking=scoreDigits(histRef.current);scoreRef.current=ranking;
   // One snapshot contains scores for ALL ten digits on each observed market tick.
   // Five consecutive snapshots establish both three-tick score momentum and
   // whether that momentum is still accelerating. No extra scan or API call.
   if(ranking.length===10){
     const snapshot:Record<number,number>={};
     ranking.forEach(r=>{snapshot[r.digit]=r.score});
     scoreHistoryRef.current=[...scoreHistoryRef.current.slice(-4),snapshot];
   }
   const top=ranking[0];
   const hist=scoreHistoryRef.current;
   const newest=hist.length>=5?hist.slice(-5):[];
   // Future-expiry candidate strength, NOT a calibrated win probability.
   // Momentum is a soft feature; a one-tick momentum dip does not disqualify
   // a digit with stronger transition evidence and stable V1 scores.
   type ExpiryCandidate={digit:number;score:number;momentum:number;positiveSteps:number;strength:number;support:number};
   const candidates:ExpiryCandidate[]=ranking.map(row=>{
     const values=newest.map(snapshot=>snapshot[row.digit]);
     const deltas=values.slice(1).map((value,i)=>value-values[i]);
     const momentum=values.length===5?values[4]-values[1]:0;
     const positiveSteps=deltas.filter(x=>x>0).length;
     const stability=deltas.length?1-Math.min(1,deltas.reduce((sum,x)=>sum+Math.abs(x),0)/Math.max(1,Math.abs(values[values.length-1]-values[0])+6)):0.5;
     // Existing transition1/2 signals are smoothed estimates based on past
     // digit transitions; treat them as weak signals, not future certainty.
     const transitions=Math.max(0,Math.min(1,(row.transition1*0.55+row.transition2*0.45)/0.35));
     const scoreStrength=50+35*Math.tanh(row.score/12);
     const momentumStrength=50+35*Math.tanh(momentum/6);
     const stabilityStrength=100*Math.max(0,Math.min(1,stability));
     const recent=histRef.current.slice(-25);
     const recentFrequency=recent.filter(d=>d===row.digit).length/Math.max(1,recent.length);
     const frequencyStrength=50+35*Math.tanh((recentFrequency-0.1)*4);
     const strength=0.46*scoreStrength+0.24*(transitions*100)+0.12*stabilityStrength+0.12*frequencyStrength+0.06*momentumStrength;
     return {digit:row.digit,score:row.score,momentum,positiveSteps,strength,support:transitions};
   }).sort((a,b)=>b.strength-a.strength||b.score-a.score);
   // Minimum V1 score is the only mandatory candidate-quality filter. The
   // minimum momentum is advisory: lowering momentum alone must not halt all
   // trading when other metrics favor a digit.
   const qualified=candidates.filter(c=>c.score>=Number(settings.threshold));
   const best=qualified[0];
   let selected=lockRef.current;
   if(settings.strategy==='MOMENTUM_LOCK'){
     // Manual fixed-tick lock: no automatic replacement due to momentum,
     // strength, ranking or eligibility changes while a lock is active.
     // The establishing tick counts as tick 1. At the configured lifetime
     // release the digit and consider a DIFFERENT qualified digit on this tick.
     if(selected && selected.elapsed>=Number(settings.lockDuration)){
       const expiredDigit=selected.digit;
       const replacement=qualified.find(c=>c.digit!==expiredDigit);
       selected=replacement?{digit:replacement.digit,elapsed:1,
         signal:{score:replacement.score,momentum3:replacement.momentum,
                 positiveSteps:replacement.positiveSteps,threshold:Number(settings.threshold)}}:null;
     }else if(selected){
       // Preserve the original digit until exactly the user-set tick count.
       selected={...selected,elapsed:selected.elapsed+1};
     }else if(best){
       selected={digit:best.digit,elapsed:1,
         signal:{score:best.score,momentum3:best.momentum,
                 positiveSteps:best.positiveSteps,threshold:Number(settings.threshold)}};
     }
     lockRef.current=selected;
     setLockPosition(selected?.elapsed??0);
   }else if(selected){lockRef.current=null;selected=null;setLockPosition(0)}
   // Render-only state: the tick callback chooses and buys synchronously.
   setHistory(histRef.current);setScores(ranking);
   // A locked digit stays tradable for the full configured window even if its
   // current score drops below threshold. Threshold is for NEW selections.
   const chosen=settings.strategy==='MOMENTUM_LOCK'
     ? candidates.find(c=>c.digit===selected?.digit):best;
   setTopMomentum(chosen?.momentum??null);
   setExpiryStrength(chosen?.strength??null);
   if(!active.current||halt.current||!settings.accountId||!settings.isConnected)return;
   if(!ranking.length){setEntryStatus('V1 warming up');return}
   if(countRef.current>=Number(settings.limit)){halt.current=true;active.current=false;setMode('MAX_TRADES');setEntryStatus('Max trades reached');return}
   if(!chosen || (settings.strategy==='MOMENTUM_LOCK' && !selected)){
     setEntryStatus('Waiting for a qualifying future-expiry candidate');return;
   }
   const target=chosen.digit;
   const signal={score:chosen.score,momentum3:chosen.momentum,positiveSteps:chosen.positiveSteps,threshold:Number(settings.threshold)};
   const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
   // Forecast the contract's FUTURE expiry digit from the just-observed tick.
   // Deriv determines entry and expiry after the buy; this is not a prediction
   // of the already-observed signal digit.
   const signalTickMatch=digit===target;
   // If the live digit matches a contract already open for the active target,
   // pause further purchases until Deriv settles that matching contract.
   if(signalTickMatch){
     for(const [id,contract] of outstanding.current){
       if(contract.digit===target)matchHoldIds.current.add(id);
     }
     if(matchHoldIds.current.size>0)setMatchHoldCount(matchHoldIds.current.size);
   }
   if(matchHoldIds.current.size>0 || pendingMatchObserved.current){setEntryStatus('Matching contract · awaiting settlement');return}
   if(pending.current){setEntryStatus('Waiting for buy acknowledgment');return}
   if(outstanding.current.size>=4){setEntryStatus('4 contracts unsettled');return}
   // One purchase per tick; after buy #1 ACK, wait for a NEW market tick.
   if(sequence<=lastBuySignalSequence.current || sequence<=lastBuyAcknowledgedAtSequence.current){setEntryStatus('Awaiting new tick');return}
   const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),confirmedLosses.current));
   if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
    stop();setMode('MAX_LOSS');return;
   }
   setEntryStatus('Forecasting future expiry · sending buy');
   lockedRef.current=target;setLockedDigit(target);setTarget(target);
   // Lock purchase immediately; no React rerender or effect scheduling required.
   void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,settings.strategy==='MOMENTUM_LOCK'?Number(settings.lockDuration):0,signalTickMatch);
 },[stop,setTarget]);

 useEffect(()=>{
  if(!ws)return;
  // Existing socket listener is retained for lowest possible latency.
  return ws.onMessage((frame:Record<string,unknown>)=>{
   if(frame.msg_type==='tick' && frame.tick)processMarketTick(frame.tick);
  });
 },[ws,processMarketTick]);

 useEffect(()=>{
  // useTicks has a dedicated subscription and powers the working market UI.
  // Feed its ticks to V1 as well; shared keys prevent duplicate buys.
  if(!isConnected || !currentTick || !symbol)return;
  processMarketTick({...currentTick,symbol});
 },[currentTick,symbol,isConnected,processMarketTick]);

 function start(){
  if(!valid||!accountId||!isConnected||!ws||pending.current||active.current||outstanding.current.size)return;
  const acc=real?'REAL MONEY':'DEMO';
  if(real&&!window.confirm(`REAL MONEY: Automated DigitMatch on ${symbol}, with up to FOUR unsettled contracts at once. Up to ${limit} purchases, progression ${factor}×, maximum cycle loss $${maxLoss}. Confirm you accept overlapping real-money exposure.`))return;
  if(!window.confirm(`Start ${acc} automatic cycle? Contract: 1-tick DigitMatch. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
  // Must begin a fresh cycle. Uncertain purchases cannot be reset with this control.
  if(mode==='UNCERTAIN'||outstanding.current.size>0)return;
  matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');countRef.current=0;pnlRef.current=0;confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;lockRef.current=null;setLockPosition(0);setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTarget(null);setLastOutcome(null);winConfirmed.current=false;setErr('');halt.current=false;active.current=true;setMode('RUNNING');if(sound)tone('buy');
 }
 return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Auto Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
  <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
    <label className="flex items-center gap-2">Trade method
      <select value={strategy} disabled={active.current||pending.current||outstandingCount>0} onChange={e=>{const v=e.target.value as Strategy;setStrategy(v);lockRef.current=null;setLockPosition(0)}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white">
        <option value="DYNAMIC">Dynamic V1</option><option value="MOMENTUM_LOCK">Momentum Lock</option>
      </select>
    </label>
    {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Hold ticks <input type="number" min="1" max="30" step="1" value={lockDuration} disabled={active.current||pending.current||outstandingCount>0} onChange={e=>setLockDuration(e.target.value)} className="w-14 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white" /></label>}
    {strategy==='MOMENTUM_LOCK'&&<span className="text-emerald-400">{lockRef.current?`Locked ${lockRef.current.digit} · tick ${lockPosition}/${lockDuration}`:'Waiting for next qualified digit'}</span>}
  </div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pending.current} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top digit',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
    <span className={topMomentum===null?'text-slate-400':topMomentum>0?'font-bold text-emerald-400':'font-bold text-rose-400'}>
      Momentum {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)}`}
    </span>
    <span className="text-slate-300">Expiry forecast {strategy==='MOMENTUM_LOCK' ? lockRef.current?.digit ?? '—' : pending.current ? lockedDigit ?? '—' : '—'}</span>
     <span className="text-cyan-300">Signal strength {expiryStrength===null?'warming up':expiryStrength.toFixed(1)+'/100'} (heuristic)</span>
    <span className="text-slate-400">Open {outstandingCount}/4</span>
    {active.current && <span className={/awaiting settlement/i.test(entryStatus) ? "font-semibold text-yellow-400" : "text-slate-400"}>{entryStatus}</span>}

    {mode==='UNCERTAIN'&&<span className="font-bold text-amber-300">Settlement needs verification</span>}
  </div>
  <div className="mt-2 flex items-center gap-2">
    <button
      disabled={!active.current && (!valid||!accountId||!isConnected||pending.current||outstandingCount>0||mode==='UNCERTAIN')}
      onClick={() => { if(active.current) stop(); else start(); }}
      className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}
    >{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
    <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
  </div>
  {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Verified contract #{lastOutcome.id} · target {lastOutcome.digit} · expiry {lastOutcome.expiryDigit??'unavailable'} · signal tick {lastOutcome.signalEpoch} · buy {lastOutcome.purchaseEpoch??'unavailable'} · expiry time {lastOutcome.expiryEpoch??'unavailable'}</span></div>}
  {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}

 </div></section>
}
