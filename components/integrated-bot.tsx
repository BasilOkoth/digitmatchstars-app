'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {getLastDigit} from '@/lib/digit-stats';
import {scoreDigits} from '@/lib/digitmatch-score';
import {NextTickIntelligence} from '@/lib/next-tick-intelligence';
import {ExecutionAwareForecast} from '@/lib/execution-aware-forecast';
import {useExecutionTarget,useEngineForecast} from './digit-stats-bar';
import type {Tick,DerivWS} from '@deriv/core';

type Mode='IDLE'|'RUNNING'|'BUYING'|'SETTLING'|'WIN'|'MAX_TRADES'|'MAX_LOSS'|'UNCERTAIN'|'STOPPED';
type Outcome={id:number;digit:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS';expiryDigit:number|null;expiryEpoch:number|null;signalEpoch:number;purchaseEpoch:number|null};
type Strategy='MOMENTUM_LOCK';
type MomentumTrade = {strategy?:Strategy;lockTick?:number;lockDuration?:number;signalEpoch?:number;purchaseEpoch?:number|null;expiryEpoch?:number|null;expiryDigit?:number|null;signalSequence?:number;signalToSubmitMs?:number;buyAcknowledgmentMs?:number;ticksDuringAcknowledgment?:number;signalAgeBudgetMs?:number;entryEpoch?:number|null;entryDigit?:number|null;entrySpot?:string|null;exitSpot?:string|null;recordType:'TRADE';contractId:number;accountId:string;symbol:string;timestamp:string;targetDigit:number;score:number;momentum3:number;positiveSteps:number;momentumRising:boolean;threshold:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
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
type TradeNotice={id:number;profit:number;contractId:number;kind:'WIN'|'LOSS'};
function SettlementToast({notice,onDismiss}:{notice:TradeNotice|null;onDismiss:()=>void}){
 useEffect(()=>{if(!notice)return;const timer=window.setTimeout(onDismiss,5500);return()=>window.clearTimeout(timer)},[notice,onDismiss]);
 if(!notice)return null;
 const win=notice.kind==='WIN';
 return <div role="status" aria-live="polite" className="fixed right-4 top-5 z-[100] w-[min(23rem,calc(100vw-2rem))] animate-in slide-in-from-top-3 fade-in duration-300">
  <div className={`overflow-hidden rounded-2xl border p-4 shadow-2xl backdrop-blur-xl ${win?'border-emerald-400/70 bg-[#062b23]/95 text-emerald-100 shadow-emerald-900/40':'border-rose-400/70 bg-[#34131d]/95 text-rose-100 shadow-rose-950/40'}`}>
   <div className="flex items-start gap-3">
    <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl ${win?'bg-emerald-400/20':'bg-rose-400/20'}`}>{win?'✓':'✕'}</span>
    <div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-[.18em] opacity-75">Trade settled</p><p className={`text-xl font-black tracking-wide ${win?'text-emerald-300':'text-rose-300'}`}>{win?'WIN · PROFIT':'LOSS'}</p><p className={`mt-1 text-2xl font-black tabular-nums ${win?'text-green-400':'text-red-400'}`}>{notice.profit>=0?'+':'−'}${Math.abs(notice.profit).toFixed(2)}</p><p className="mt-1 text-xs opacity-75">Deriv contract #{notice.contractId}</p></div>
    <button type="button" aria-label="Dismiss trade notification" onClick={onDismiss} className="rounded-lg px-2 py-1 text-lg opacity-70 transition hover:bg-white/10 hover:opacity-100">×</button>
   </div>
   <div className={`mt-3 h-1 w-full rounded-full ${win?'bg-emerald-400/30':'bg-rose-400/30'}`}><div className={`h-full w-full rounded-full ${win?'bg-emerald-400':'bg-rose-400'}`}/></div>
  </div>
 </div>;
}
function DigitMatchStrategy({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,onBusyChange}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;onBusyChange:(busy:boolean)=>void}){
 const {setTarget} = useExecutionTarget();
 const {publishForecast} = useEngineForecast();
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
 const strategy:Strategy='MOMENTUM_LOCK';const [horizon,setHorizon]=useState<'1'|'3'|'5'>('3');const lockDuration=horizon;
 const lockRef=useRef<{digit:number;elapsed:number;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number}}|null>(null);
 // The locked digit is armed on the tick that creates the lock. A later matching
 // market tick immediately freezes new buys until Deriv confirms settlement.
 const lockArmedAfterSequence=useRef(0);
 const matchHoldTriggered=useRef(false);
 const matchHoldSequence=useRef<number|null>(null);
 const [lockPosition,setLockPosition]=useState(0);
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('6');const [minMomentum,setMinMomentum]=useState('0');
 const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
 const [notice,setNotice]=useState<TradeNotice|null>(null);
 const dismissNotice=useCallback(()=>setNotice(null),[]);
 const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
 const scoreHistoryRef=useRef<Record<number,number>[]>([]);
 const intelligenceRef=useRef(new NextTickIntelligence());
 const executionForecastRef=useRef(new ExecutionAwareForecast());
 const [executionAudit,setExecutionAudit]=useState<ReturnType<ExecutionAwareForecast['audit']>|null>(null);
 const [horizonTarget,setHorizonTarget]=useState<number|null>(null);
 const [horizonProbability,setHorizonProbability]=useState<number|null>(null);
 const [intelligenceAudit,setIntelligenceAudit]=useState<ReturnType<NextTickIntelligence['getAudit']>|null>(null);
 const outstanding=useRef(new Map<number,{digit:number;stake:number;signalEpoch:number;purchaseEpoch:number|null;}>());
 const reservedStake=useRef(0);
 // Every distinct incoming tick can submit one purchase without waiting for settlement.
 // Outstanding requests have their own acknowledgement and contract monitors.
 const pendingCount=useRef(0);
 const inFlight=useRef(new Map<number,{digit:number;stake:number}>());
 const [inFlightCount,setInFlightCount]=useState(0);
 const [riskExposure,setRiskExposure]=useState(0);
 const [sentCount,setSentCount]=useState(0);
 const [lastTiming,setLastTiming]=useState<{contractId:number;target:number;signalSequence:number;ackTicks:number;submitMs:number;buyMs:number;entryDigit:number|null;expiryDigit:number|null;result:'WIN'|'LOSS'}|null>(null);
 const refreshExposure=()=>{setRiskExposure(reservedStake.current);setInFlightCount(pendingCount.current)};
 // Uncertain purchase outcomes stop further purchases until reconciliation.
 const uncertainPurchase=useRef(false);
 const [entryStatus,setEntryStatus]=useState('Waiting for signal');
 // Multi-contract executor: market ticks never substitute for Deriv settlement.
 const lastSignalDispatchMs=useRef<number|null>(null);
 // Hold the stop-after-win state while other already-purchased contracts settle.
 const winConfirmed=useRef(false);
 // Record the stream at ingress, independently of React rendering and settlement.
 // An expiry can correspond to ANY observed post-buy tick, not necessarily the first.
 const streamTicks=useRef<Array<{epoch:number;digit:number;quote:number;receivedAt:number}>>([]);
 const tickStats=useRef({received:0,outOfOrder:0,duplicates:0,staleQuotes:0});
 // A monotonic local sequence is essential: multiple market ticks may share one epoch second.
 const tickSequence=useRef(0);
 // Enforce one submitted order per unique tick, not one contract at a time.
 const lastBuySignalSequence=useRef(0);
 const lastBuyAcknowledgedAtSequence=useRef(0);
 // De-duplicate delayed copies from the raw and useTicks fallback feeds.
 const seenTickKeys=useRef(new Set<string>());
 const seenTickOrder=useRef<string[]>([]);
 const tickCadence=useRef<{lastArrival:number|null;intervalMs:number|null}>({lastArrival:null,intervalMs:null});
 const [cadenceLabel,setCadenceLabel]=useState('Measuring tick interval');
 const [streamStatus,setStreamStatus]=useState('Tick stream warming up');
 // Market digits never pause execution or settle contracts. Only Deriv settlement can confirm WIN.
 const [outstandingCount,setOutstandingCount]=useState(0);
 useEffect(()=>{onBusyChange(active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')},[mode,outstandingCount,inFlightCount,onBusyChange]);
 const confirmedLosses=useRef(0);
 const [syncStatus,setSyncStatus]=useState('Waiting for a purchase');
 const [topMomentum,setTopMomentum]=useState<number|null>(null);
 const [targetMomentum,setTargetMomentum]=useState<number|null>(null);
 const [targetProbability,setTargetProbability]=useState<number|null>(null);
  const [targetScore,setTargetScore]=useState<number|null>(null);
  const [targetRises,setTargetRises]=useState<number|null>(null);
 // Next-tick audit: a prediction is frozen on tick N and graded ONLY on tick N+1.
 // Sampled only when V1's score and momentum conditions qualify; no look-ahead.
 const nextTickPending=useRef<number|null>(null);
 const eligibleResults=useRef<number[]>([]);
 const [accuracyAudit,setAccuracyAudit]=useState({trials:0,hits:0,lower95:0});
 const [requireEvidence,setRequireEvidence]=useState(false);
 const wilsonLower=(hits:number,n:number)=>{
   if(!n)return 0;
   const z=1.96, p=hits/n, z2=z*z;
   return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n);
 };
 // Evidence gate is deliberately conservative: a positive V1 score is not an edge.
 // A strategy cannot buy until 150 eligible forecasts are checked, and the
 // 95% Wilson lower bound on its NEXT-tick hit rate exceeds the random 10% baseline.
 const evidenceReady=accuracyAudit.trials>=150 && accuracyAudit.lower95>0.1;
 const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
 const valid=Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0;
 const next=amount(Number(base)*Math.pow(Number(factor),countRef.current));const scopeKey=`${accountId}:${symbol}`;
 const [latency,setLatency]=useState<{quote:number;buy:number;settlement:number}|null>(null);
 const [dispatchTiming,setDispatchTiming]=useState<{signalToSubmitMs:number;acknowledgmentMs:number;ticksDuringAck:number}|null>(null);
 const signalTimingRef=useRef({signalToSubmitMs:0,acknowledgmentMs:0,ticksDuringAck:0});
 const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
 const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
 const stop=useCallback(()=>{halt.current=true;active.current=false;matchHoldSequence.current=null;lockArmedAfterSequence.current=0;setTarget(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);setMode(m=>m==='RUNNING'?'STOPPED':m)},[setTarget]);
 useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];intelligenceRef.current.reset();executionForecastRef.current.reset();setLastTiming(null);setExecutionAudit(null);setHorizonTarget(null);setHorizonProbability(null);setIntelligenceAudit(null);nextTickPending.current=null;eligibleResults.current=[];setAccuracyAudit({trials:0,hits:0,lower95:0});if(!unsettled)confirmedLosses.current=0;lockRef.current=null;lockArmedAfterSequence.current=0;matchHoldTriggered.current=false;matchHoldSequence.current=null;setLockPosition(0);setTopMomentum(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);lockedRef.current=null;if(!unsettled){countRef.current=0;setSentCount(0);lossBlockRef.current=0;pnlRef.current=0;}if(!unsettled){pending.current=false;pendingCount.current=0;inFlight.current.clear();setInFlightCount(0);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';setEntryStatus('Waiting for signal');tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');setHistory([]);setScores([]);setLockedDigit(null);setTarget(null);setCount(0);setPnl(0);setLossBlock(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv before restarting.');else setErr('')}},[scopeKey,setTarget]);
 const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,firstLockMatch:boolean)=>{
  if(!ws||!accountId||halt.current||!active.current||winConfirmed.current||uncertainPurchase.current||matchHoldTriggered.current||countRef.current>=Number(limit))return;
  // Never replay ticks skipped while a previous buy was in flight.
  if(signalSequence<=lastBuySignalSequence.current)return;
  // Reserve a distinct slot for this tick. No waiting for previous settlement.
  if(inFlight.current.has(signalSequence))return;
  pendingCount.current++;
  pending.current=true;
  inFlight.current.set(signalSequence,{digit:predicted,stake});
  refreshExposure();
  setMode('BUYING');let contractId:number|undefined;let purchaseAttempted=false;
  // Reserve this risk immediately so a later tick cannot exceed the cycle budget.
  reservedStake.current=amount(reservedStake.current+stake);refreshExposure();
  try{
   if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
   // Both Demo and Real use the same one-request Deriv buy. One tick can
   // trigger at most one irreversible purchase; the WS acknowledgement is
   // never interpreted as an already-settled WIN.
   if(tickSequence.current!==signalSequence || signalSequence<=lastBuySignalSequence.current || halt.current || matchHoldTriggered.current){
     tickStats.current.staleQuotes++;
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     setMode(outstanding.current.size?'SETTLING':'RUNNING');
     return;
   }
   const elapsedMs=performance.now()-signalReceivedAt;
   const freshnessBudgetMs=Math.max(120,Math.min(1000,(tickCadence.current.intervalMs??1000)*0.65));
   if(elapsedMs>freshnessBudgetMs){
    tickStats.current.staleQuotes++;
    reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
    setEntryStatus('Signal expired before dispatch · awaiting fresh tick');
    setMode('RUNNING');
    return;
   }
   // Final synchronous kill-switch at the irreversible dispatch boundary.
   // A matching locked digit may have arrived while this signal was being prepared;
   // never let a queued/stale callback reach ws.send after that observation.
   if(matchHoldTriggered.current || winConfirmed.current || halt.current || !active.current ||
      tickSequence.current!==signalSequence){
     tickStats.current.staleQuotes++;
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     setEntryStatus(matchHoldTriggered.current
       ? `MATCH HOLD · locked digit ${lockRef.current?.digit??'—'} appeared · no new buys`
       : 'Signal blocked at dispatch · awaiting a fresh eligible tick');
     return;
   }
   // Reserve this tick before an irreversible buy request.
   // The next request must be driven by a *later tick*, not a queued signal.
   lastBuySignalSequence.current=signalSequence;
   // Mark request attempted immediately before dispatch. Do not retry ambiguous buys.
   purchaseAttempted=true;
   // Count submissions BEFORE awaiting network response, preventing duplicates and
   // exceeding the configured max during overlapping acknowledgements.
   countRef.current++;
   setCount(countRef.current);
   setSentCount(countRef.current);
   const buyStart=performance.now();
   const signalToSubmitMs=Math.max(0,Math.round(buyStart-signalReceivedAt));
   // Dispatch before touching React state. This returns a promise and normally
   // writes to the existing open WebSocket synchronously.
   const buyPromise=ws.send<any>({
     buy:'1', price:amount(stake*1.05),
     parameters:{amount:stake,basis:'stake',contract_type:'DIGITMATCH',
       currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,
       barrier:String(predicted)},
   });
   setMode('BUYING');
   setDispatchTiming(old=>({signalToSubmitMs,acknowledgmentMs:old?.acknowledgmentMs??0,ticksDuringAck:old?.ticksDuringAck??0}));
   const bought=await buyPromise;
   const buyMs=Math.round(performance.now()-buyStart);
   const ticksDuringAcknowledgment=Math.max(0,tickSequence.current-signalSequence);
   executionForecastRef.current.observeAcknowledgment(ticksDuringAcknowledgment);
   const acknowledgedAt=performance.now();
   signalTimingRef.current={signalToSubmitMs,acknowledgmentMs:buyMs,ticksDuringAck:ticksDuringAcknowledgment};
   setDispatchTiming(signalTimingRef.current);
   const quoteMs=0;
   const paid=Number(bought?.buy?.buy_price);
   const ask=Number.isFinite(paid)&&paid>0?paid:stake;
   setLatency({quote:quoteMs,buy:buyMs,settlement:0});
   // Purchase acknowledgement is the earliest safe point to associate subsequent market ticks.
   const purchaseEpoch=Number(bought?.buy?.start_time ?? bought?.buy?.purchase_time ?? bought?.buy?.transaction_time);
   const acknowledgedEpoch=Number.isFinite(purchaseEpoch)&&purchaseEpoch>0?purchaseEpoch:null;
   contractId=Number(bought?.buy?.contract_id);
   if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
   // Later ticks were already allowed to buy while this ACK was in flight.
   if(!Number.isFinite(ask)||ask<=0||ask>stake*1.05+0.001)throw new Error('Confirmed purchase price exceeds maximum; reconcile with Deriv');
   play('buy');
   // Keep risk reserved and register the contract before releasing this ACK slot.
   reservedStake.current=amount(reservedStake.current-stake+ask);
   outstanding.current.set(contractId,{digit:predicted,stake:ask,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});
   // An observed target digit while BUYING is not a contract win or an entry veto.
   // Only Deriv's proposal_open_contract response can settle this contract.
   setSyncStatus(`Bought #${contractId} · target ${predicted} · signal ${tickEpoch} · ${acknowledgedEpoch===null?'purchase time unavailable':`buy ${acknowledgedEpoch}`}`);
   setOutstandingCount(outstanding.current.size);
   if(active.current && !halt.current && !winConfirmed.current && !uncertainPurchase.current)setMode('RUNNING');
   const id=contractId;
   // Background settlement monitor; later ticks can dispatch overlapping contracts.
   void (async()=>{
    let unsubscribe:(()=>Promise<void>)|undefined;
    const settlementStart=performance.now();
    try{
     const settle=await new Promise<any>((resolve,reject)=>{
      let done=false;
      let pollTimer:ReturnType<typeof setInterval>|undefined;
      const timeout=setTimeout(()=>finish(null,new Error(`Unconfirmed contract ${id}; reconciliation required`)),45000);
      function finish(c:any,error?:Error){
       if(done)return;
       done=true;clearTimeout(timeout);
       if(pollTimer)clearInterval(pollTimer);
       if(error)reject(error);else resolve(c);
      }
      const handle=(frame:Record<string,unknown>)=>{
       const c=(frame as any).proposal_open_contract;
       if(Number(c?.contract_id)!==id)return;
       if(c.is_sold || c.status==='won' || c.status==='lost')finish(c);
      };
      void ws.subscribe({proposal_open_contract:1,contract_id:id},handle)
       .then(sub=>{unsubscribe=sub.unsubscribe;if(done)void sub.unsubscribe()})
       .catch(()=>{
        if(done)return;
        const poll=async()=>{
         try{handle(await ws.send<any>({proposal_open_contract:1,contract_id:id}))}catch{/* retry until timeout */}
        };
        pollTimer=setInterval(()=>void poll(),1200);
        void poll();
       });
     });
     const payout=Number(settle.sell_price??settle.payout); const buyPrice=Number(settle.buy_price??ask);
     if(!Number.isFinite(payout)||!Number.isFinite(buyPrice)||payout<0||buyPrice<=0)throw new Error('Settlement amounts unavailable');
     setLatency(old=>old?{...old,settlement:Math.round(performance.now()-settlementStart)}:null);
     const profit=amount(payout-buyPrice);pnlRef.current=amount(pnlRef.current+profit);setPnl(pnlRef.current);
     const win=profit>0;
     executionForecastRef.current.observeSettlement(win);
     const expiryDigit=expiryDigitOf(settle,pipSize);
     const entrySpot=settle.entry_spot??settle.entry_tick??null;
     const entryEpochRaw=Number(settle.entry_spot_time??settle.entry_tick_time);
     const entryEpoch=Number.isFinite(entryEpochRaw)&&entryEpochRaw>0?entryEpochRaw:null;
     const entryDigit=spotDigit(entrySpot,pipSize);
     const expiryEpochRaw=Number(settle.exit_spot_time??settle.exit_tick_time);
     const expiryEpoch=Number.isFinite(expiryEpochRaw)&&expiryEpochRaw>0?expiryEpochRaw:null;
     setLastTiming({contractId:id,target:predicted,signalSequence,ackTicks:ticksDuringAcknowledgment,
       submitMs:signalToSubmitMs,buyMs:Math.round(acknowledgedAt-buyStart),entryDigit,expiryDigit,
       result:win?'WIN':'LOSS'});
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
     setNotice({id:Date.now(),contractId:id,profit,kind:win?'WIN':'LOSS'});
     setLastOutcome(old=>old?.outcome==='WIN'&&!win?old:{id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS',expiryDigit,expiryEpoch,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});play(win?'win':'loss');
     const journalRow:MomentumTrade={signalSequence,signalToSubmitMs,ticksDuringAcknowledgment,signalAgeBudgetMs:Math.max(120,Math.min(1000,(tickCadence.current.intervalMs??1000)*0.65)),buyAcknowledgmentMs:Math.round(acknowledgedAt-buyStart),entryEpoch,entryDigit,entrySpot:entrySpot===null?null:String(entrySpot),exitSpot:settle.exit_spot===undefined?null:String(settle.exit_spot),strategy:entryStrategy,lockTick,lockDuration:lockWindow,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch,expiryEpoch,expiryDigit,recordType:'TRADE',contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,momentumRising:signal.momentum3>0&&signal.positiveSteps>=2,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'};
     try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:MomentumTrade)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
     // Settlement runs in the background; only confirmed settlement frees the slot.
     outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);refreshExposure();
     if(win){winConfirmed.current=true;halt.current=true;active.current=false;matchHoldTriggered.current=true;lockedRef.current=null;lockRef.current=null;setLockedDigit(null);setLockPosition(0);setTarget(null);setTargetScore(null);setTargetMomentum(null);setTargetProbability(null);setTargetRises(null);setMode('WIN')}
     else {
      confirmedLosses.current++;
      if(winConfirmed.current){setMode('WIN')}
      else if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}
      else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){halt.current=true;active.current=false;setMode('MAX_LOSS')}
      else if(active.current&&!halt.current&&!uncertainPurchase.current){setMode('RUNNING');setEntryStatus('Settled · next eligible tick may submit a buy');}
     }
    }catch(e){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv before restarting.`)}
    finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size);refreshExposure()}
   })();
  }catch(e){halt.current=true;active.current=false;
   // Uncertain buy: retain reservation. Do not retry or initiate more purchases.
   if(purchaseAttempted){uncertainPurchase.current=true;setMode('UNCERTAIN');setErr(`Purchase status unknown: ${String(e)}. Reconcile in Deriv.`)}
   else{reservedStake.current=Math.max(0,amount(reservedStake.current-stake));setMode('STOPPED');setErr(`No trade was purchased: ${String(e)}`)}
  }finally{
    inFlight.current.delete(signalSequence);
    pendingCount.current=Math.max(0,pendingCount.current-1);
    pending.current=pendingCount.current>0;
    refreshExposure();
    if(matchHoldTriggered.current && !winConfirmed.current && pendingCount.current===0 && outstanding.current.size===0){
      setMode('UNCERTAIN');
      setEntryStatus(`Locked digit ${lockRef.current?.digit??'—'} appeared on tick ${matchHoldSequence.current??'—'}; no Deriv WIN confirmation received. Trading remains held; reconcile the contract results.`);
      setErr('Matching market digit observed, but no authoritative winning settlement has been confirmed. Trading remains paused.');
    }
  }
 },[ws,accountId,symbol,limit,maxLoss,play,setTarget,pipSize]);
 const execRef=useRef(execute);execRef.current=execute; // Keep callback current without waiting for a post-render effect.
 useEffect(()=>{if(!isConnected && active.current){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr('Connection lost. Verify outstanding contracts on Deriv before a new cycle.');}},[isConnected]);
 // Process the live WebSocket frame synchronously, BEFORE React's render cycle.
 // Reuse the existing market subscription; do not create a duplicate tick feed.
 const tickSettings=useRef({pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizon});
 tickSettings.current={pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizon};
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
    // Never advance the V1 model using a delayed snapshot. Ignoring it before
    // deduplication also avoids treating delayed data as a live entry signal.
   if(epoch*1000<Date.now()-5000 || epoch*1000>Date.now()+5000){
     tickStats.current.staleQuotes++;
     return;
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
    // Reject market events materially older than the local wall clock.
    // A 5-second threshold is conservative and avoids buying on buffered ticks.
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
   // CRITICAL STOP: as soon as a post-lock market tick prints the locked digit,
   // stop dispatching on this very callback. Already-sent buys cannot be cancelled;
   // they remain monitored until Deriv provides authoritative settlement.
   if(!matchHoldTriggered.current && !winConfirmed.current &&
      lockRef.current && sequence>lockArmedAfterSequence.current && digit===lockRef.current.digit){
     matchHoldTriggered.current=true;
     matchHoldSequence.current=sequence;
     halt.current=true;
     active.current=false;
     setMode('SETTLING');
     setEntryStatus(`LOCKED DIGIT ${digit} APPEARED on tick ${sequence} · new trades on hold · awaiting Deriv confirmation`);
     if(pendingCount.current===0 && outstanding.current.size===0){
       setMode('UNCERTAIN');
       setErr('The locked digit appeared, but there is no outstanding contract to confirm it. Trading remains paused; verify the Deriv contract history.');
     }
   }
   tickStats.current.received++;
   // A market match while BUY is pending or contracts are open may correspond
   // to an outstanding order, but does not establish which expiry wins.
   // Deriv's authoritative contract settlement is the only source of WIN/LOSS.
   if(tickStats.current.received%5===0){
     const ms=tickCadence.current.intervalMs;
     setCadenceLabel(ms===null?'Measuring tick interval':`${(ms/1000).toFixed(2)}s/tick · ${(1000/ms).toFixed(2)} ticks/s`);
     setStreamStatus(`Stream ${tickStats.current.received} ticks · duplicates ${tickStats.current.duplicates} · out of order ${tickStats.current.outOfOrder} · stale quotes ${tickStats.current.staleQuotes}`);
   }
   // Grade the PREVIOUS tick's eligible forecast before computing today's scores.
   // This evaluates a single-digit next-tick prediction, not top-five coverage.
   if(nextTickPending.current!==null){
     const hit=Number(digit===nextTickPending.current);
     eligibleResults.current=[...eligibleResults.current.slice(-499),hit];
     const n=eligibleResults.current.length;
     const hits=eligibleResults.current.reduce((a,b)=>a+b,0);
     setAccuracyAudit({trials:n,hits,lower95:wilsonLower(hits,n)});
   }
   nextTickPending.current=null;
   histRef.current=[...histRef.current.slice(-99),digit];
   // Market observations update forecasting; a post-lock matching digit freezes new buys, while Deriv alone confirms settlement.
   // Causal all-ten-digit evaluation: grade the prior frozen forecast, then
   // produce the next forecast from history that ends at this observed tick.
   const ranking=intelligenceRef.current.observe(digit);scoreRef.current=ranking;
   // Auxiliary forward-horizon research is deliberately scheduled AFTER any BUY
   // dispatch. It is not an eligibility filter and must not slow the tick callback.
   // We use the same frozen ranking snapshot and process each tick in sequence.
   const telemetryScope=scope.current;
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     executionForecastRef.current.observe(digit);
     const research=executionForecastRef.current.forecast(ranking);
     const execTop=research?.ranked?.[0]??null;
     setHorizonTarget(execTop?.digit??null);
     setHorizonProbability(execTop?.executionProbability??null);
     if(sequence%5===0){
       setExecutionAudit(executionForecastRef.current.audit());
       setIntelligenceAudit(intelligenceRef.current.getAudit());
     }
   });
   const top=ranking[0];
   // Derive momentum from the SAME all-ten forecast used for prediction.
   // Do not recompute it from a separately modified score ranking.
   const momentum=top?.momentum3 ?? null;
   const rises=top?.positiveSteps ?? 0;
   const rising=momentum!==null && momentum>0 && momentum>=Number(settings.minMomentum) && rises>=2;
   const supported=Boolean(top && top.probability>=.10);
   // Execution forecasts are research-only: they must not replace the V1 target.
   // The 10% probability baseline is descriptive, not an entry veto.
   // Freeze only a qualifying V1 signal for NEXT tick's scorecard.
   // This is independent of trade execution and stays active while the bot is stopped.
   // In Momentum Lock, audit the LOCKED target (when present), not an unrelated top-ranked digit.
   // The lock may expire later this tick; the frozen audit remains causally valid.
   const auditCandidate=settings.strategy==='MOMENTUM_LOCK' && lockRef.current
     ? ranking.find(row=>row.digit===lockRef.current!.digit)
     : top;
   if(auditCandidate && auditCandidate.score>=Number(settings.threshold) &&
      auditCandidate.momentum3>0 && auditCandidate.momentum3>=Number(settings.minMomentum) &&
      auditCandidate.positiveSteps>=2){
     nextTickPending.current=auditCandidate.digit;
   }
   // Render-only state; purchase scheduling does not wait for it.
   // Keep UI rendering off the critical send path. Forecasting above is synchronous;
   // visual updates are not. Never use this queued UI work as a trade trigger.
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     setHistory(histRef.current);setScores(ranking);setTopMomentum(momentum);
   });
   // Momentum Lock stays on the FIRST selected digit until that digit appears.
   // Every fresh tick trades that same target; the lock is not silently rotated
   // or expired just because another digit becomes top-ranked.
   let selected=lockRef.current;
   if(selected){
     selected={...selected,elapsed:selected.elapsed+1};
     if(selected.elapsed>Number(settings.horizon)){
       lockRef.current=null;selected=null;setLockPosition(0);setLockedDigit(null);
       setEntryStatus('Forecast window expired · searching for a new Momentum Lock candidate');
     }else{
       lockRef.current=selected;setLockPosition(selected.elapsed);
     }
   }
   // Current top and locked target can differ. Display both independently.
   const displayTarget=settings.strategy==='MOMENTUM_LOCK' ? selected?.digit ?? top?.digit ?? null : top?.digit ?? null;
   const displayForecast=ranking.find(row=>row.digit===displayTarget);
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     setTargetMomentum(displayForecast?.momentum3??null);
     setTargetProbability(displayForecast?.probability??null);
     setTargetScore(displayForecast?.score??null);
     setTargetRises(displayForecast?.positiveSteps??null);
   });
   // Publish precisely the ranking computed by this engine for this market tick.
   // The callback reads the final lock state when it runs, so a newly-created
   // Momentum Lock remains visually distinct from the top-ranked forecast.
   // Presentation updates never delay or initiate a buy.
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     publishForecast({
       symbol:settings.symbol,
       sequence,
       rows:ranking.map(row=>({digit:row.digit,score:row.score,
         probability:row.probability,momentum3:row.momentum3,positiveSteps:row.positiveSteps})),
       lockedDigit:lockRef.current?.digit??null,
     });
   });
   if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected)return;
   if(!ranking.length){setEntryStatus('Building momentum signal');return}
   if(countRef.current>=Number(settings.limit)){halt.current=true;active.current=false;setMode('MAX_TRADES');setEntryStatus('Max trades reached');return}
   // Momentum Lock selects and holds one qualifying digit for the chosen forecast window.
   if(!top){setEntryStatus('Building momentum signal');return}
   if(!selected){
     const h=Number(settings.horizon);
     const ticks=streamTicks.current;
     const recent=ticks.slice(-30);
     const candidates=ranking.filter(row=>{
       if(!Number.isFinite(row.score)||row.score<Number(settings.threshold)||row.momentum3<=0||row.momentum3<Number(settings.minMomentum)||row.positiveSteps<2)return false;
       const recentCount=recent.filter(t=>t.digit===row.digit).length;
       if(recentCount<2)return false;
       const positions=[];
       for(let i=0;i<ticks.length;i++)if(ticks[i].digit===row.digit)positions.push(i);
       const gaps=[];for(let i=1;i<positions.length;i++)gaps.push(positions[i]-positions[i-1]);
       const currentGap=positions.length?ticks.length-1-positions[positions.length-1]:ticks.length;
       if(gaps.length>=5){
         const sorted=[...gaps].sort((a,b)=>a-b);const p90=sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.9)-1)];
         if(currentGap>p90)return false;
       }
       let trials=0,hits=0;
       for(let i=0;i<ticks.length-h;i++){
         trials++;if(ticks.slice(i+1,i+1+h).some(t=>t.digit===row.digit))hits++;
       }
       const baseline=1-Math.pow(.9,h);
       if(trials<25||hits/trials<baseline+.02)return false;
       return true;
     });
     const hot=candidates.sort((a,b)=>b.score-a.score)[0];
     if(!hot){setEntryStatus(`No Momentum Lock candidate meets the ${h}-tick and long-tail filters · waiting`);return}
     selected={digit:hot.digit,elapsed:1,signal:{score:hot.score,momentum3:hot.momentum3,positiveSteps:hot.positiveSteps,threshold:Number(settings.threshold)}};
     lockRef.current=selected;lockArmedAfterSequence.current=sequence;setLockPosition(1);
     setTargetMomentum(hot.momentum3);setTargetProbability(hot.probability);setTargetScore(hot.score);setTargetRises(hot.positiveSteps);
   }
   // Momentum Lock is the only strategy: retain the selected digit until its forecast window expires or it appears.
   const target=selected!.digit;
   const chosenForecast=ranking.find(row=>row.digit===target);
   if(!chosenForecast){setEntryStatus('V1 target unavailable');return}
   const ownMomentum=chosenForecast.momentum3;
   const ownRises=chosenForecast.positiveSteps;
   const ownRising=ownMomentum>0 && ownMomentum>=Number(settings.minMomentum) && ownRises>=2;
   // Deliberately do not reject V1 purely for an uncalibrated 10% probability
   // estimate. Such thresholds are evaluated offline against actual outcomes.
   const signal={score:chosenForecast.score,momentum3:ownMomentum,positiveSteps:ownRises,threshold:Number(settings.threshold)};
   const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
   // The observed digit may equal the predicted digit; the contract expires on the next tick.
   // Send on every fresh tick while the Momentum Lock remains valid. Settlement is
   // exclusively determined by Deriv, asynchronously after the BUY acknowledgment.
   const firstLockMatch=false;
   // Do NOT wait for ACK/settlement: each fresh tick has its own dispatch.
   // Execute at most one purchase per unique qualifying tick; do not wait for settlement.
   if(sequence<=lastBuySignalSequence.current){setEntryStatus('Awaiting new tick');return}
   const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
   if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
    stop();setMode('MAX_LOSS');return;
   }
   // IMPORTANT: dispatch the request BEFORE any React state/context updates.
   // The executor reserves the tick and pending slot synchronously up to ws.send().
   lastSignalDispatchMs.current=receivedAt;
   lockedRef.current=target;
   void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,Number(settings.horizon),firstLockMatch);
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     setLockedDigit(target);setTarget(target);
     setEntryStatus(`Sent on tick ${sequence} · ${pendingCount.current} ACK pending / ${outstanding.current.size} settling`);
   });
 },[stop,setTarget,requireEvidence,publishForecast]);

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
  if(!valid||!accountId||!isConnected||!ws||pendingCount.current>0||active.current||uncertainPurchase.current||outstanding.current.size)return;
  const acc=real?'REAL MONEY':'DEMO';
  if(real&&!window.confirm(`REAL MONEY: Automated DigitMatch on ${symbol}, with potentially MULTIPLE simultaneous contracts. Up to ${limit} purchases, progression ${factor}×, maximum cycle loss $${maxLoss}. Confirm you accept this risk.`))return;
  if(!window.confirm(`Start ${acc} Momentum Lock cycle? Contract: 1-tick DigitMatch; trade the Momentum Lock target within a ${horizon}-tick forecast window, reject long-tail candidates, and stop immediately when the locked digit appears. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
  // Must begin a fresh cycle. Uncertain purchases cannot be reset with this control.
  if(mode==='UNCERTAIN'||uncertainPurchase.current||pendingCount.current>0||outstanding.current.size>0)return;
  setEntryStatus('Waiting for signal');countRef.current=0;setSentCount(0);pnlRef.current=0;reservedStake.current=0;setRiskExposure(0);confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;lockRef.current=null;lockArmedAfterSequence.current=0;matchHoldTriggered.current=false;matchHoldSequence.current=null;setLockPosition(0);setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTarget(null);setLastOutcome(null);setTargetScore(null);setTargetRises(null);setTargetMomentum(null);setTargetProbability(null);winConfirmed.current=false;setErr('');halt.current=false;active.current=true;setLastTiming(null);setMode('RUNNING');if(sound)tone('buy');
 }
 return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Tick-Synchronized Rapid Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
  <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
    <label className="flex items-center gap-2">Forecast window
      <select value={horizon} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setHorizon(e.target.value as '1'|'3'|'5')} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white">
        <option value="1">Immediate · 1 tick</option><option value="3">Short · 3 ticks</option><option value="5">Extended · 5 ticks</option>
      </select>
    </label>
    <span className="text-slate-300">Momentum Lock · long-tail filter on</span>
    {lockRef.current&&<span className="font-semibold text-emerald-400">Locked {lockRef.current.digit} · {lockPosition}/{horizon}</span>}
  </div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top digit',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
    <span className="text-slate-300">Locked digit: <strong className="text-emerald-400">{winConfirmed.current?'—':lockRef.current?.digit??'Searching'}</strong></span>
    <span className="text-slate-300">Trades {count}/{limit}</span>
    <span className="text-slate-300">Open {outstandingCount} · pending {inFlightCount}</span>
    <span className="text-slate-300">Exposure ${riskExposure.toFixed(2)}</span>
    <span className="text-slate-300">{entryStatus}</span>
    {mode==='UNCERTAIN'&&<span className="font-bold text-amber-300">Verify settlement in Deriv</span>}
  </div>
  <div className="mt-2 flex items-center gap-2">
    <button
      disabled={!active.current && (!valid||!accountId||!isConnected||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')}
      onClick={() => { if(active.current) stop(); else start(); }}
      className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}
    >{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
    <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
  </div>
  <SettlementToast notice={notice} onDismiss={dismissNotice}/>
  {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Verified contract #{lastOutcome.id} · target {lastOutcome.digit} · expiry {lastOutcome.expiryDigit??'unavailable'} · signal tick {lastOutcome.signalEpoch} · buy {lastOutcome.purchaseEpoch??'unavailable'} · expiry time {lastOutcome.expiryEpoch??'unavailable'}</span></div>}
  {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}

 </div></section>
}





type Ledger={day:string;account:string;attempts:number;profit:number;uncertain:boolean;pendingContractId?:number|null};
const dayUTC=()=>new Date().toISOString().slice(0,10);
const storageKey=(account:string,day:string=dayUTC())=>`dms-differs-v1:${account}:${day}`;
const readLedger=(account:string):Ledger=>{
 const fresh={day:dayUTC(),account,attempts:0,profit:0,uncertain:false,pendingContractId:null};
 try{const raw=localStorage.getItem(storageKey(account));if(!raw)return fresh;const v=JSON.parse(raw);if(v.day===fresh.day&&v.account===account&&Number.isInteger(v.attempts)&&v.attempts>=0&&Number.isFinite(v.profit))return {...fresh,...v}}catch{}
 return fresh;
};
// Daily realized P/L is stored under one per-account, per-UTC-day key.
// Rebuild cumulative totals from those ledgers so the display survives a
// browser refresh and UTC day rollover without resetting older profits.
type PLTotals={lifetime:number;last30Days:number;days:number};
const readPLTotals=(account:string):PLTotals=>{
 const result:PLTotals={lifetime:0,last30Days:0,days:0};
 const prefix=`dms-differs-v1:${account}:`;
 const today=new Date();
 const todayUTC=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
 try{
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);
   if(!key?.startsWith(prefix))continue;
   const day=key.slice(prefix.length);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
   const v=JSON.parse(localStorage.getItem(key)||'null') as Ledger|null;
   if(!v||v.account!==account||v.day!==day||!Number.isFinite(v.profit))continue;
   result.days++;
   result.lifetime+=v.profit;
   const dayMs=Date.parse(`${day}T00:00:00Z`);
   const ageDays=(todayUTC-dayMs)/86400000;
   if(Number.isInteger(ageDays)&&ageDays>=0&&ageDays<30)result.last30Days+=v.profit;
  }
 }catch{/* Browser storage unavailable: numbers can be incomplete. */}
 result.lifetime=amount(result.lifetime);
 result.last30Days=amount(result.last30Days);
 return result;
};
const persist=(ledger:Ledger)=>{try{localStorage.setItem(storageKey(ledger.account,ledger.day),JSON.stringify(ledger))}catch{}};
const digitOf=(tick:Tick,pipSize:number)=>{
 const p=Number.isInteger((tick as any).pip_size)&&(tick as any).pip_size>=0&&(tick as any).pip_size<=12?(tick as any).pip_size:pipSize;
 return getLastDigit(Number(tick.quote),Number.isInteger(p)&&p>=0&&p<=12?p:2);
};
const wilsonUpperBound=(hits:number,n:number)=>{
 if(n<=0)return 1;
 const z=1.96,p=hits/n,z2=z*z,den=1+z2/n;
 const centre=p+z2/(2*n),spread=z*Math.sqrt((p*(1-p)+z2/(4*n))/n);
 return Math.min(1,(centre+spread)/den);
};
function DigitDiffersStrategy({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,onBusyChange}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;onBusyChange:(busy:boolean)=>void}){
 const [stake,setStake]=useState('50');
 const [dailyLoss,setDailyLoss]=useState('250');
 const [enforceFivePerDay,setEnforceFivePerDay]=useState(true);
 const [minObservations,setMinObservations]=useState('1000');
 const [notice,setNotice]=useState<TradeNotice|null>(null);
 const dismissNotice=useCallback(()=>setNotice(null),[]);
 const [enabled,setEnabled]=useState(false);
 const [liveApproved,setLiveApproved]=useState(false);
 const [ledger,setLedger]=useState<Ledger|null>(null);
 const [plTotals,setPLTotals]=useState<PLTotals>({lifetime:0,last30Days:0,days:0});
 const [status,setStatus]=useState('Stopped');
 const [error,setError]=useState('');
 const [settlementVerified,setSettlementVerified]=useState(false);
 const [recent,setRecent]=useState<number[]>([]);
 const [selected,setSelected]=useState<number|null>(null);
 const busy=useRef(false);
 useEffect(()=>{onBusyChange(enabled||busy.current||uncertain.current)},[enabled,status,onBusyChange]);
 const enabledRef=useRef(false);
 const lastTick=useRef('');
 const latestLedger=useRef<Ledger|null>(null);
 const history=useRef<number[]>([]);
 const session=useRef('');
 const uncertain=useRef(false);
 const reconciling=useRef(false);
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));
 const isLive=Boolean(accountId)&&!demo;
 const update=(v:Ledger)=>{latestLedger.current=v;setLedger(v);persist(v);setPLTotals(readPLTotals(v.account))};
 const stop=useCallback((message:string)=>{enabledRef.current=false;setEnabled(false);setStatus(message)},[]);
 useEffect(()=>{
  setSettlementVerified(false);
  stop('Stopped — account or market changed');busy.current=false;uncertain.current=false;history.current=[];lastTick.current='';setRecent([]);setSelected(null);setLiveApproved(false);
  if(accountId){const l=readLedger(accountId);latestLedger.current=l;setLedger(l);setPLTotals(readPLTotals(accountId));uncertain.current=l.uncertain}else{latestLedger.current=null;setLedger(null);setPLTotals({lifetime:0,last30Days:0,days:0})}
  session.current=`${accountId??''}:${symbol}`;
 },[accountId,symbol,stop]);
 // Reconcile only a broker-acknowledged contract ID. Never repeat a buy.
 // The contract ID and attempted slot survive refreshes and WebSocket reconnects.
 useEffect(()=>{
  if(!accountId||!ws||!isConnected)return;
  const saved=readLedger(accountId);
  if(!saved.uncertain||!saved.pendingContractId)return;
  let cancelled=false;
  const reconcile=async()=>{
   if(cancelled||reconciling.current||busy.current)return;
   reconciling.current=true;
   try{
    const frame=await ws.send<any>({proposal_open_contract:1,contract_id:saved.pendingContractId});
    if(cancelled)return;
    const c=frame?.proposal_open_contract;
    if(Number(c?.contract_id)!==saved.pendingContractId)throw new Error('Contract ID mismatch');
    if(!(c.is_sold||c.status==='won'||c.status==='lost')){
     setStatus(`Contract #${saved.pendingContractId} open — awaiting broker settlement`);return;
    }
    const profit=Number(c.profit);
    if(!Number.isFinite(profit))throw new Error('Broker settlement has no profit');
    const latest=readLedger(accountId);
    if(!latest.uncertain||latest.pendingContractId!==saved.pendingContractId)return;
    const next={...latest,profit:Number((latest.profit+profit).toFixed(2)),uncertain:false,pendingContractId:null};
    update(next);uncertain.current=false;setError('');
    setStatus(`Reconciled contract #${saved.pendingContractId}: ${profit>=0?'WIN':'LOSS'} ${profit.toFixed(2)} USD — press Start to resume`);
    setNotice({id:Date.now(),contractId:saved.pendingContractId!,profit,kind:profit>0?'WIN':'LOSS'});
   }catch(e){if(!cancelled)setStatus(`Reconciliation pending for #${saved.pendingContractId} — waiting for Deriv connection`)}
   finally{reconciling.current=false}
  };
  void reconcile();const timer=setInterval(()=>void reconcile(),5000);
  return()=>{cancelled=true;clearInterval(timer)};
 },[accountId,ws,isConnected]);
 const monitor=useCallback(async(id:number,connection:DerivWS):Promise<any>=>new Promise((resolve,reject)=>{
  let done=false;let unsub:(()=>Promise<unknown>|void)|undefined;let poll:ReturnType<typeof setInterval>|undefined;
  const timeout=setTimeout(()=>finish(null,new Error('Settlement not confirmed; manual reconciliation required')),60000);
  function finish(c:any,e?:Error){if(done)return;done=true;clearTimeout(timeout);if(poll)clearInterval(poll);void unsub?.();e?reject(e):resolve(c)}
  const handle=(frame:Record<string,unknown>)=>{const c=(frame as any).proposal_open_contract;if(Number(c?.contract_id)!==id)return;if(c.is_sold||c.status==='won'||c.status==='lost')finish(c)};
  void connection.subscribe({proposal_open_contract:1,contract_id:id},handle).then(s=>{unsub=s.unsubscribe;if(done)void s.unsubscribe()}).catch(()=>{
   const check=async()=>{try{handle(await connection.send<any>({proposal_open_contract:1,contract_id:id}))}catch{}};
   poll=setInterval(()=>void check(),1500);void check();
  });
 }),[]);
 useEffect(()=>{
  if(!isConnected||!currentTick||!symbol||!accountId||!ws)return;
  const key=`${currentTick.symbol}:${currentTick.epoch}:${currentTick.id}:${currentTick.quote}`;
  if(lastTick.current===key)return;lastTick.current=key;
  if(currentTick.symbol!==symbol)return;
  const digit=digitOf(currentTick,pipSize);
  if(!Number.isInteger(digit)||digit<0||digit>9)return;
  history.current=[...history.current.slice(-4999),digit];
  const arr=history.current;setRecent(arr.slice(-50));
  if(!enabledRef.current||busy.current||uncertain.current)return;
  const l=latestLedger.current;
  if(!l||l.account!==accountId||l.day!==dayUTC()){stop('Daily boundary reached — restart to load new UTC day');return}
  if(enforceFivePerDay&&l.attempts>=5){stop('Daily limit: 5 purchases');return}
  const amount=Number(stake),maxLoss=Number(dailyLoss),minimum=Number(minObservations);
  if(!Number.isFinite(amount)||amount<50||!Number.isFinite(maxLoss)||maxLoss<amount||!Number.isInteger(minimum)||minimum<1000){stop('Invalid risk or signal settings');return}
  if(l.profit-amount < -maxLoss){stop('Daily loss exposure limit');return}
  if(arr.length<minimum+1){setStatus(`Warming up: ${arr.length}/${minimum+1} ticks`);return}
  // Use the user-selected sample size, excluding the current tick. Split chronologically
  // into independent training (60%) and validation (40%) windows.
  const past=arr.slice(0,-1);
  if(past.length<minimum){setStatus(`Warming up: ${past.length}/${minimum} completed ticks`);return}
  const sample=past.slice(-minimum);
  const trainCount=Math.floor(sample.length*0.6);
  const training=sample.slice(0,trainCount),validation=sample.slice(trainCount);
  const counts=Array.from({length:10},(_,d)=>training.filter(x=>x===d).length);
  const target=counts.indexOf(Math.min(...counts));
  const valHits=validation.filter(d=>d===target).length;
  setSelected(target);
  // Conservative holdout gate: require the 95% Wilson upper bound for the
  // barrier's occurrence rate to be below 10%. This is stronger than comparing
  // a tiny validation percentage with 10%, but it still does not prove future edge.
  const barrierUpper95=wilsonUpperBound(valHits,validation.length);
  const winProbabilityLower95=1-barrierUpper95;
  if(barrierUpper95>=0.10){setStatus(`No trade: barrier ${target} upper 95% occurrence bound ${(barrierUpper95*100).toFixed(2)}% is not below 10%`);return}
  if(isLive&&!liveApproved){stop('Live account requires explicit confirmation');return}
  // Obtain the broker's current quote first. Do not count a proposal request as a trade.
  busy.current=true;
  setStatus(`Checking live DIGITDIFF quote for barrier ${target}`);
  const entrySession=session.current;
  void (async()=>{
   let purchaseAttempted=false;
   let reserved:Ledger|null=null;
   try{
    const quoteFrame=await ws.send<any>({proposal:1,amount,basis:'stake',contract_type:'DIGITDIFF',currency:'USD',duration:1,duration_unit:'t',symbol,barrier:String(target)});
    const proposal=quoteFrame?.proposal;
    const proposalId=String(proposal?.id??'');
    const askPrice=Number(proposal?.ask_price);
    const totalPayout=Number(proposal?.payout);
    if(!proposalId||!Number.isFinite(askPrice)||askPrice<=0||!Number.isFinite(totalPayout)||totalPayout<=askPrice){setStatus('No trade: Deriv did not return a valid positive-profit proposal');return}
    const winProfit=totalPayout-askPrice;
    const conservativeEV=winProbabilityLower95*winProfit-(1-winProbabilityLower95)*askPrice;
    if(!(conservativeEV>0)){setStatus(`No trade: conservative payout-adjusted EV is ${conservativeEV.toFixed(3)} USD at ${ (winProbabilityLower95*100).toFixed(2)}% lower-bound win probability`);return}
    // Reserve a purchase slot synchronously immediately before the irreversible buy.
    const latest=latestLedger.current;
    if(!latest||latest.account!==accountId||latest.day!==dayUTC())return;
    reserved={...latest,attempts:latest.attempts+1};update(reserved);
    setStatus(`Buying DIGITDIFF barrier ${target} · conservative EV +$${conservativeEV.toFixed(3)} · ${reserved.attempts}${enforceFivePerDay?'/5':''}`);
    purchaseAttempted=true;
    const result=await ws.send<any>({buy:proposalId,price:askPrice});
    const id=Number(result?.buy?.contract_id);
    if(!Number.isSafeInteger(id)||id<=0)throw new Error('Purchase acknowledgment missing contract ID');
    update({...reserved!,uncertain:true,pendingContractId:id});
    setStatus(`Contract ${id}: waiting for broker settlement`);
    const c=await monitor(id,ws);
    const profit=Number(c?.profit);
    if(!Number.isFinite(profit))throw new Error('Settlement has no valid profit value');
    // Avoid applying an old account's outcome to a new account's ledger.
    const current=latestLedger.current;
    if(session.current===entrySession&&current&&current.account===accountId&&current.day===reserved!.day){
     const next={...current,profit:Number((current.profit+profit).toFixed(2)),uncertain:false,pendingContractId:null};update(next);uncertain.current=false;
     setStatus(`Settled: ${profit>=0?'WIN':'LOSS'} ${profit.toFixed(2)} USD · ${next.attempts}${enforceFivePerDay?'/5':''}`);
     setNotice({id:Date.now(),contractId:id,profit,kind:profit>0?'WIN':'LOSS'});
     if((enforceFivePerDay&&next.attempts>=5)||next.profit<=-maxLoss)stop('Daily risk/trade limit reached');
    }
   }catch(e){
    const current=latestLedger.current;
    if(purchaseAttempted&&session.current===entrySession&&current&&current.account===accountId){update({...current,uncertain:true});uncertain.current=true;stop(current.pendingContractId?'Settlement pending — automatic reconciliation on reconnect':'Purchase acknowledgement unknown — manual reconciliation required');setError(current.pendingContractId?`Contract #${current.pendingContractId} will be checked against Deriv before another trade.`:`Purchase confirmation missing. Check Deriv transaction history before resuming. ${String(e)}`)}
    else if(session.current===entrySession){setStatus(`No purchase sent: proposal/quote failed (${String(e)})`)}
   }finally{busy.current=false}
  })();
 },[accountId,currentTick,dailyLoss,enforceFivePerDay,isConnected,isLive,liveApproved,minObservations,monitor,pipSize,stake,stop,symbol,ws]);
 // Explicit demo-only acknowledgement of a broker-verified settlement when no
 // contract ID was received. Do not modify attempts or realized P/L: the
 // unknown settlement cannot be reliably attributed to the local ledger.
 const clearVerifiedPurchase=()=>{
  if(!demo||!accountId||!isConnected||!settlementVerified||busy.current||reconciling.current||enabledRef.current)return;
  const current=readLedger(accountId);
  if(!current.uncertain||current.pendingContractId){setError('This contract has a known ID; wait for automatic broker reconciliation.');return}
  const next={...current,uncertain:false,pendingContractId:null};
  update(next);uncertain.current=false;setSettlementVerified(false);setError('');
  setStatus('Verified settled purchase cleared — ready to start');
 };
 const start=()=>{
  setError('');if(!accountId||!ws||!isConnected){setError('Connect your Deriv account first');return}
  const l=readLedger(accountId);update(l);
  if(l.uncertain){setError(l.pendingContractId?`Contract #${l.pendingContractId} is awaiting automatic reconciliation with Deriv.`:'Purchase acknowledgement is missing. Check Deriv transaction history before continuing.');return}
  if(enforceFivePerDay&&l.attempts>=5){setError('Five trades already attempted today (UTC). Disable the five-trade limit to continue, subject to the loss cap.');return}
  if(isLive&&!liveApproved){setError('Confirm live trading first.');return}
  if(Number(stake)<50||!Number.isFinite(Number(stake))||Number(dailyLoss)<Number(stake)||(!Number.isInteger(Number(minObservations))||Number(minObservations)<1000)){setError('Invalid settings: stake ≥ $50, loss cap ≥ stake, minimum completed ticks ≥ 1000.');return}
  enabledRef.current=true;setEnabled(true);setStatus('Monitoring ticks for qualifying signal');
 };
 return <section className="rounded-xl border border-slate-600 p-4 space-y-3 text-sm">
  <div className="flex justify-between gap-2"><h3 className="font-bold text-lg">Selective Digit Differs</h3><span>{demo?'DEMO':isLive?'LIVE':'DISCONNECTED'}</span></div>
  <div className="grid grid-cols-2 gap-2">
   <label>Stake USD<input className="block w-full rounded border bg-transparent p-2" type="number" min="50" step="0.01" value={stake} disabled={enabled} onChange={e=>setStake(e.target.value)}/></label>
   <label>Daily loss cap USD<input className="block w-full rounded border bg-transparent p-2" type="number" min="50" step="0.01" value={dailyLoss} disabled={enabled} onChange={e=>setDailyLoss(e.target.value)}/></label>
   <label>Minimum completed ticks<input className="block w-full rounded border bg-transparent p-2" type="number" min="1000" step="1" value={minObservations} disabled={enabled} onChange={e=>setMinObservations(e.target.value)}/></label>
  </div>
  <label className="flex items-center gap-2 rounded-lg border border-slate-700 p-2"><input type="checkbox" checked={enforceFivePerDay} disabled={enabled||busy.current} onChange={e=>setEnforceFivePerDay(e.target.checked)}/><span>Enforce maximum 5 trades per UTC day</span></label>
  {isLive&&<label className="flex gap-2"><input type="checkbox" checked={liveApproved} disabled={enabled} onChange={e=>setLiveApproved(e.target.checked)}/> I understand these are real-money $50+ trades and authorize live execution.</label>}
  <div className="flex gap-2"><button className="rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-40" disabled={enabled||busy.current||!isConnected} onClick={start}>Start selective bot</button><button className="rounded bg-slate-600 px-4 py-2 text-white" onClick={()=>stop('Stopped — existing contract will still settle')}>Stop</button></div>
  <p>Today: <strong>{ledger?.attempts??0}{enforceFivePerDay?'/5':''}</strong> attempted · Realized P/L <strong className={`font-black tabular-nums ${(ledger?.profit??0)>0?'text-green-400':(ledger?.profit??0)<0?'text-red-400':'text-slate-100'}`}>{(ledger?.profit??0)>0?'PROFIT ': (ledger?.profit??0)<0?'LOSS ':''}{(ledger?.profit??0)>=0?'+':'−'}${Math.abs(ledger?.profit??0).toFixed(2)}</strong> · Candidate digit: {selected??'—'}</p>
  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Persistent Digit Differs profit and loss">
   {([['Today (UTC)',ledger?.profit??0],['Last 30 UTC days',plTotals.last30Days],['All recorded days',plTotals.lifetime]] as const).map(([label,value])=><div key={label} className="rounded-lg border border-slate-700 bg-slate-900/70 p-3"><div className="text-xs text-slate-400">{label} realized P/L</div><div className={`text-xl font-black tabular-nums ${value>0?'text-green-400':value<0?'text-red-400':'text-slate-100'}`}>{value>=0?'+':'−'}${Math.abs(value).toFixed(2)}</div></div>)}
  </div>
  <p className="text-xs text-slate-400">DigitDiffers only buys when the holdout confidence gate passes and the live Deriv quote has positive conservative expected value. This is still historical evidence, not a guarantee. P/L is restored from this browser's saved daily ledgers for the connected account ({plTotals.days} recorded UTC days). Day-to-day totals do not reset when a new day begins. Browser storage is not a cross-device or broker-backed record; reconcile with Deriv statements.</p>
  {demo&&ledger?.uncertain&&!ledger.pendingContractId&&<div className="space-y-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-amber-100">
   <div className="font-extrabold text-amber-300">Purchase confirmation missing</div>
   <p className="text-xs">Only use this recovery after checking Deriv demo transaction history and confirming the last purchase has settled and no related contract remains open. This does not change recorded profit or trade attempts.</p>
   <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={settlementVerified} onChange={e=>setSettlementVerified(e.target.checked)}/> I verified the last purchase is settled in Deriv and there is no related open contract.</label>
   <button type="button" className="rounded-lg bg-amber-500 px-3 py-2 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40" disabled={!settlementVerified||busy.current||reconciling.current||enabled} onClick={clearVerifiedPurchase}>Clear verified settled purchase</button>
  </div>}
  <SettlementToast notice={notice} onDismiss={dismissNotice}/>
  <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 font-semibold ${/settlement|settling|submitting|pending|waiting for broker/i.test(status)?'border-amber-500/40 bg-amber-500/10 text-amber-300':/settled.*win/i.test(status)?'border-emerald-500/40 bg-emerald-500/10 text-emerald-300':/settled.*loss|uncertain|invalid|limit reached|halted/i.test(status)?'border-rose-500/40 bg-rose-500/10 text-rose-300':/monitoring|warming|waiting/i.test(status)?'border-sky-500/40 bg-sky-500/10 text-sky-300':'border-slate-600 bg-slate-800/50 text-slate-200'}`}><span className="inline-block h-2 w-2 shrink-0 rounded-full bg-current"/><span className="uppercase tracking-wide text-xs">Status</span><span>{status}</span></div>{error&&<p role="alert" className="font-semibold text-red-400">{error}</p>}
 </section>;
}


// One trading panel, one Deriv connection and market feed. Only the selected
// contract strategy is mounted; the contract selector locks while any order is
// running, pending settlement or uncertain. No second independent dashboard.
type ContractMode='DIGITMATCH'|'DIGITDIFF';
type TradingProps={ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string};
export function IntegratedBot(props:TradingProps){
 const [contract,setContract]=useState<ContractMode>('DIGITMATCH');
 const [locked,setLocked]=useState(false);
 const activity=useCallback((busy:boolean)=>setLocked(busy),[]);
 return <div className="space-y-2">
  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-cyan-500/30 bg-[#101a2e] p-3 text-sm text-white">
   <label className="flex items-center gap-2 font-semibold">Contract
    <select aria-label="Contract type" value={contract} disabled={locked} onChange={e=>setContract(e.target.value as ContractMode)} className="rounded border border-slate-600 bg-[#0b1425] px-3 py-2 text-white disabled:opacity-50">
     <option value="DIGITMATCH">Digit Match</option><option value="DIGITDIFF">Digit Differs — selective</option>
    </select>
   </label>
   {locked&&<span className="text-amber-300">Contract selection locked until trading and settlement finish</span>}
  </div>
  {contract==='DIGITMATCH'?<DigitMatchStrategy {...props} onBusyChange={activity}/>:<DigitDiffersStrategy {...props} onBusyChange={activity}/>}
 </div>;
}
