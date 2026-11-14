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
type Strategy='DYNAMIC'|'MOMENTUM_LOCK';
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
 const [strategy,setStrategy]=useState<Strategy>('DYNAMIC');const [lockDuration,setLockDuration]=useState('5');
 const lockRef=useRef<{digit:number;elapsed:number;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number}}|null>(null);
 const [lockPosition,setLockPosition]=useState(0);
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('6');const [minMomentum,setMinMomentum]=useState('0');
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
 const matchPause=useRef(false);
 const [inFlightCount,setInFlightCount]=useState(0);
 const [matchPaused,setMatchPaused]=useState(false);
 const [riskExposure,setRiskExposure]=useState(0);
 const [sentCount,setSentCount]=useState(0);
 const [lastTiming,setLastTiming]=useState<{contractId:number;target:number;signalSequence:number;ackTicks:number;submitMs:number;buyMs:number;entryDigit:number|null;expiryDigit:number|null;result:'WIN'|'LOSS'}|null>(null);
 const refreshExposure=()=>{setRiskExposure(reservedStake.current);setInFlightCount(pendingCount.current)};
 const releaseMatchPause=()=>{
   if(matchPause.current && pendingCount.current===0 && outstanding.current.size===0 && !uncertainPurchase.current && !winConfirmed.current){
     matchPause.current=false;setMatchPaused(false);
     if(active.current && !halt.current && !winConfirmed.current){setMode('RUNNING');setEntryStatus('All contracts settled without WIN · awaiting fresh tick')}
   }
 };
 // Uncertain purchase outcomes stop further purchases until reconciliation.
 const uncertainPurchase=useRef(false);
 // Legacy match-hold counter; dedicated matchPause controls new purchases.
 const matchHoldIds=useRef(new Set<number>());
 const [matchHoldCount,setMatchHoldCount]=useState(0);
 const [entryStatus,setEntryStatus]=useState('Waiting for signal');
 // Multi-contract executor: market ticks never substitute for Deriv settlement.
 const lastSignalDispatchMs=useRef<number|null>(null);
 // Track unsettled targets from both pending ACKs and purchased contracts.
 const pendingMatchObserved=useRef(false);
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
 // A matched observed digit pauses all NEW buys until outstanding orders settle.
 // A matching market digit is NOT a verified contract win.
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
 const valid=Number.isInteger(Number(lockDuration))&&Number(lockDuration)>=1&&Number(lockDuration)<=30&&Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0;
 const next=amount(Number(base)*Math.pow(Number(factor),countRef.current));const scopeKey=`${accountId}:${symbol}`;
 const [latency,setLatency]=useState<{quote:number;buy:number;settlement:number}|null>(null);
 const [dispatchTiming,setDispatchTiming]=useState<{signalToSubmitMs:number;acknowledgmentMs:number;ticksDuringAck:number}|null>(null);
 const signalTimingRef=useRef({signalToSubmitMs:0,acknowledgmentMs:0,ticksDuringAck:0});
 const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
 const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
 const stop=useCallback(()=>{halt.current=true;active.current=false;setTarget(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);setMode(m=>m==='RUNNING'?'STOPPED':m)},[setTarget]);
 useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];intelligenceRef.current.reset();executionForecastRef.current.reset();setLastTiming(null);setExecutionAudit(null);setHorizonTarget(null);setHorizonProbability(null);setIntelligenceAudit(null);nextTickPending.current=null;eligibleResults.current=[];setAccuracyAudit({trials:0,hits:0,lower95:0});if(!unsettled)confirmedLosses.current=0;lockRef.current=null;setLockPosition(0);setTopMomentum(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);lockedRef.current=null;if(!unsettled){countRef.current=0;setSentCount(0);lossBlockRef.current=0;pnlRef.current=0;}if(!unsettled){pending.current=false;pendingCount.current=0;inFlight.current.clear();matchPause.current=false;setMatchPaused(false);setInFlightCount(0);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';if(!unsettled)matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');setHistory([]);setScores([]);setLockedDigit(null);setTarget(null);setCount(0);setPnl(0);setLossBlock(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv before restarting.');else setErr('')}},[scopeKey,setTarget]);
 const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,firstLockMatch:boolean)=>{
  if(!ws||!accountId||halt.current||!active.current||winConfirmed.current||uncertainPurchase.current||matchPause.current||countRef.current>=Number(limit))return;
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
   if(tickSequence.current!==signalSequence || signalSequence<=lastBuySignalSequence.current || halt.current || matchPause.current){
     tickStats.current.staleQuotes++;
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     setMode(outstanding.current.size?'SETTLING':'RUNNING');
     return;
   }
   // Re-check the most recent observed market digit immediately before BUY.
   // A newer tick may have arrived after the signal was selected.
   const latestMarketTick=streamTicks.current[streamTicks.current.length-1];
   if(latestMarketTick?.digit===predicted){
    reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
    setEntryStatus(`Latest digit ${predicted} matches target · no buy`);
    setMode('RUNNING');
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
   if(!matchPause.current && active.current && !halt.current && !winConfirmed.current && !uncertainPurchase.current)setMode('RUNNING');
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
     if(matchPause.current)setEntryStatus('Matched tick observed · verifying all unsettled contracts');
     outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);refreshExposure();
     if(win){winConfirmed.current=true;halt.current=true;active.current=false;matchPause.current=false;setMatchPaused(false);lockedRef.current=null;lockRef.current=null;setLockedDigit(null);setLockPosition(0);setTarget(null);setTargetScore(null);setTargetMomentum(null);setTargetProbability(null);setTargetRises(null);setMode('WIN')}
     else {
      confirmedLosses.current++;
      if(winConfirmed.current){setMode('WIN')}
      else if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}
      else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){halt.current=true;active.current=false;setMode('MAX_LOSS')}
      else if(active.current&&!halt.current&&!matchPause.current&&!uncertainPurchase.current){setMode('RUNNING');setEntryStatus('Settled · next eligible tick may submit a buy');}
     }
     releaseMatchPause();
    }catch(e){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv before restarting.`)}
    finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size);releaseMatchPause()}
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
    releaseMatchPause();
  }
 },[ws,accountId,symbol,limit,maxLoss,play,setTarget,pipSize]);
 const execRef=useRef(execute);execRef.current=execute; // Keep callback current without waiting for a post-render effect.
 useEffect(()=>{if(!isConnected && active.current){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr('Connection lost. Verify outstanding contracts on Deriv before a new cycle.');}},[isConnected]);
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
   tickStats.current.received++;
   // A market match while BUY is pending or contracts are open may correspond
   // to an outstanding order, but does not establish which expiry wins.
   // Deriv's authoritative contract settlement is the only source of WIN/LOSS.
   const matchingPending=[...inFlight.current.values()].some(c=>c.digit===digit);
   const matchingUnsettled=[...outstanding.current.values()].some(c=>c.digit===digit);
   if(active.current && !matchPause.current && (matchingPending || matchingUnsettled)){
     matchPause.current=true;
     setMatchPaused(true);
     setMode('SETTLING');
     setEntryStatus(`Market digit ${digit} matches a purchased/pending target · PAUSED for Deriv verification (not a confirmed win)`);
   }
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
   // Market observations update forecasting; a matching digit blocks a NEW BUY
   // only at the entry gates below, never settles an existing Deriv contract.
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
   // Momentum Lock lasts the configured number of observed ticks. Every new
   // tick re-evaluates the LOCKED digit's own forecast. Other digits becoming
   // top-ranked cannot silently alter an open lock or its trade target.
   let selected=lockRef.current;
   if(settings.strategy==='MOMENTUM_LOCK' && selected){
     selected={...selected,elapsed:selected.elapsed+1};
     if(selected.elapsed>Number(settings.lockDuration)){
       selected=null;lockRef.current=null;setLockPosition(0);
     } else {lockRef.current=selected;setLockPosition(selected.elapsed)}
   }else if(settings.strategy!=='MOMENTUM_LOCK' && selected){
     lockRef.current=null;selected=null;setLockPosition(0);
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
       lockedDigit:settings.strategy==='MOMENTUM_LOCK' ? lockRef.current?.digit??null : null,
     });
   });
   if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected)return;
   if(matchPause.current){setEntryStatus(`MATCH HOLD · ${outstanding.current.size} confirmed + ${pendingCount.current} pending contracts; await Deriv settlement`);return;}
   if(!ranking.length){setEntryStatus('V1 warming up');return}
   if(countRef.current>=Number(settings.limit)){halt.current=true;active.current=false;setMode('MAX_TRADES');setEntryStatus('Max trades reached');return}
   // V1 is authoritative for the candidate, score threshold and momentum.
   // The execution-horizon research is kept for audit only; a lag estimate
   // is NOT a verified expiry forecast and may not change the chosen digit.
   if(!top){setEntryStatus('V1 warming up');return}
   if(settings.strategy==='MOMENTUM_LOCK' && !selected){
     if(!Number.isFinite(top.score) || top.score<Number(settings.threshold)){setEntryStatus(`V1 score ${Number.isFinite(top.score)?top.score.toFixed(2):'—'} below minimum ${settings.threshold}`);return}
     if(!rising){setEntryStatus(`V1 momentum ${momentum?.toFixed(2)??'—'} (rising steps ${rises}/3) below eligibility`);return}
     selected={digit:top.digit,elapsed:1,signal:{score:top.score,momentum3:top.momentum3,positiveSteps:top.positiveSteps,threshold:Number(settings.threshold)}};
     lockRef.current=selected;setLockPosition(1);
     setTargetMomentum(top.momentum3);setTargetProbability(top.probability);setTargetScore(top.score);setTargetRises(top.positiveSteps);
   }
   if(settings.strategy==='DYNAMIC'){
     if(!Number.isFinite(top.score) || top.score<Number(settings.threshold)){setEntryStatus(`V1 score ${Number.isFinite(top.score)?top.score.toFixed(2):'—'} below minimum ${settings.threshold}`);return}
     if(!rising){setEntryStatus(`V1 momentum ${momentum?.toFixed(2)??'—'} (rising steps ${rises}/3) below eligibility`);return}
   }
   // Optional gate tests the actual V1 next-tick candidate, rather than a
   // different, horizon-optimized digit. The contract break-even rate may be
   // much higher than the 10% uniform random-digit baseline.
   if(requireEvidence && (eligibleResults.current.length<150 ||
       wilsonLower(eligibleResults.current.reduce((a,b)=>a+b,0),eligibleResults.current.length)<=0.1)){
     setEntryStatus(`V1 evidence gate: ${eligibleResults.current.length}/150; lower bound must exceed 10%`);
     return;
   }
   const target=settings.strategy==='MOMENTUM_LOCK'?selected!.digit:top.digit;
   const chosenForecast=ranking.find(row=>row.digit===target);
   if(!chosenForecast){setEntryStatus('V1 target unavailable');return}
   const ownMomentum=chosenForecast.momentum3;
   const ownRises=chosenForecast.positiveSteps;
   const ownRising=ownMomentum>0 && ownMomentum>=Number(settings.minMomentum) && ownRises>=2;
   if(chosenForecast.score<Number(settings.threshold) || !ownRising){
     setEntryStatus(`Locked ${target}: score ${chosenForecast.score.toFixed(2)}/${settings.threshold} · momentum ${ownMomentum.toFixed(2)}/${settings.minMomentum} · rises ${ownRises}/3; awaiting qualification`);
     return;
   }
   // Deliberately do not reject V1 purely for an uncalibrated 10% probability
   // estimate. Such thresholds are evaluated offline against actual outcomes.
   const signal={score:chosenForecast.score,momentum3:ownMomentum,positiveSteps:ownRises,threshold:Number(settings.threshold)};
   const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
   // Never enter on a market tick whose observed last digit equals the target.
   // This is an ENTRY rule, not an assumption about a Deriv contract outcome.
   if(digit===target){
     setEntryStatus(`Observed ${digit} = target ${target} · skip this tick`);
     return;
   }
   // Send only from a fresh, nonmatching observed tick. Settlement is
   // exclusively determined by Deriv, asynchronously after the BUY acknowledgment.
   const firstLockMatch=false;
   // Do NOT wait for ACK/settlement: each fresh tick has its own dispatch.
   // Execute at most one purchase on a fresh signal; require settlement and then a new tick.
   if(sequence<=lastBuySignalSequence.current){setEntryStatus('Awaiting new tick');return}
   const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
   if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
    stop();setMode('MAX_LOSS');return;
   }
   // IMPORTANT: dispatch the request BEFORE any React state/context updates.
   // The executor reserves the tick and pending slot synchronously up to ws.send().
   lastSignalDispatchMs.current=receivedAt;
   lockedRef.current=target;
   void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,settings.strategy==='MOMENTUM_LOCK'?Number(settings.lockDuration):0,firstLockMatch);
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
  if(!window.confirm(`Start ${acc} automatic cycle? Contract: 1-tick DigitMatch, one submission per eligible tick, overlapping contracts possible. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
  // Must begin a fresh cycle. Uncertain purchases cannot be reset with this control.
  if(mode==='UNCERTAIN'||uncertainPurchase.current||pendingCount.current>0||outstanding.current.size>0)return;
  matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');countRef.current=0;setSentCount(0);pnlRef.current=0;reservedStake.current=0;setRiskExposure(0);matchPause.current=false;setMatchPaused(false);confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;lockRef.current=null;setLockPosition(0);setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTarget(null);setLastOutcome(null);setTargetScore(null);setTargetRises(null);setTargetMomentum(null);setTargetProbability(null);winConfirmed.current=false;setErr('');halt.current=false;active.current=true;setLastTiming(null);setMode('RUNNING');if(sound)tone('buy');
 }
 return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Tick-Synchronized Rapid Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
  <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
    <label className="flex items-center gap-2">Trade method
      <select value={strategy} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>{const v=e.target.value as Strategy;setStrategy(v);lockRef.current=null;setLockPosition(0)}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white">
        <option value="DYNAMIC">Dynamic V1</option><option value="MOMENTUM_LOCK">Momentum Lock</option>
      </select>
    </label>
    {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Lock ticks <input type="number" min="1" max="30" step="1" value={lockDuration} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setLockDuration(e.target.value)} className="w-14 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white" /></label>}
    {strategy==='MOMENTUM_LOCK'&&<span className="text-emerald-400">{lockRef.current?`Locked ${lockRef.current.digit} · tick ${lockPosition}/${lockDuration}`:'Waiting for rising momentum'}</span>}
  </div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top digit',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
    <span className={topMomentum===null?'text-slate-400':topMomentum>0?'font-bold text-emerald-400':'font-bold text-rose-400'}>
      Momentum {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)}`}
    </span>
    <span className="text-slate-300">{strategy==='MOMENTUM_LOCK' ? 'Locked target' : 'V1 target'} {winConfirmed.current ? '—' : (strategy==='MOMENTUM_LOCK' ? lockRef.current?.digit ?? '—' : scores[0]?.digit ?? '—')}</span>
    <span className="text-cyan-300">Target V1 score {targetScore===null?'—':targetScore.toFixed(2)} / min {threshold}</span>
    <span className="text-cyan-300">Target momentum {targetMomentum===null?'—':`${targetMomentum>=0?'+':''}${targetMomentum.toFixed(2)}`} · rises {targetRises??'—'}/3</span>
    <span className="text-slate-300">Target forecast {targetProbability===null?'—':`${(targetProbability*100).toFixed(2)}%`}</span>
    <span className="text-slate-400">Open {outstandingCount} · ACK pending {inFlightCount} · At risk ${riskExposure.toFixed(2)}</span>
    {matchPaused && <strong className="text-yellow-300">MATCH HOLD · awaiting verified settlement</strong>}
    {lastTiming && <span className="text-slate-300" title="Derived from the Deriv purchase acknowledgment and contract settlement; observed market ticks do not themselves prove contract expiry">Last contract #{lastTiming.contractId} · target {lastTiming.target} · signal #{lastTiming.signalSequence} · dispatch {lastTiming.submitMs} ms · ACK {lastTiming.buyMs} ms / {lastTiming.ackTicks} ticks · Deriv entry {lastTiming.entryDigit??'unknown'} · expiry {lastTiming.expiryDigit??'unknown'} · {lastTiming.result}</span>}
    {active.current && <span className={/awaiting settlement/i.test(entryStatus) ? "font-semibold text-yellow-400" : "text-slate-400"}>{entryStatus}</span>}

    {mode==='UNCERTAIN'&&<span className="font-bold text-amber-300">Settlement needs verification</span>}
  </div>
  <div className="mt-2 rounded-md border border-slate-700/70 p-2 text-xs text-slate-300">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>Eligible V1 NEXT-tick accuracy: <strong className="text-white">{accuracyAudit.trials ? `${(100*accuracyAudit.hits/accuracyAudit.trials).toFixed(1)}%` : '—'}</strong> ({accuracyAudit.hits}/{accuracyAudit.trials}) · 95% lower bound {(accuracyAudit.lower95*100).toFixed(1)}% · random benchmark 10%</span>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={requireEvidence} disabled={active.current || pending.current || outstandingCount>0} onChange={e=>setRequireEvidence(e.target.checked)} />Require measured edge before purchases</label>
    </div>
    {intelligenceAudit && <div className="mt-1 text-[10px] text-cyan-200">All-10 digit audit: {intelligenceAudit.topHits}/{intelligenceAudit.trials} top-1 hits ({(intelligenceAudit.topHitRate*100).toFixed(1)}%) · Brier {intelligenceAudit.brier.toFixed(3)} vs uniform {intelligenceAudit.uniformBrier.toFixed(3)} · log loss {intelligenceAudit.logLoss.toFixed(3)} · leading probability {scores.length && 'probability' in scores[0] ? ((scores[0] as any).probability*100).toFixed(1)+'%' : '—'}. Online expert weights: {Object.entries(intelligenceAudit.weights).map(([k,v])=>`${k} ${(v*100).toFixed(0)}%`).join(' · ')}.</div>}
    {executionAudit && <div className="mt-1 text-[10px] text-emerald-200">Execution-aware research (observed-tick horizons, NOT verified expiry timing): {executionAudit.horizons.map(h=>`+${h.horizon}: ${h.hits}/${h.trials} (${(h.hitRate*100).toFixed(1)}%, lower 95% ${(h.lower95*100).toFixed(1)}%)`).join(' · ')}. ACK samples {executionAudit.ackSamples} · verified contracts {executionAudit.verifiedTrades} ({executionAudit.verifiedWins} wins).</div>}
    {intelligenceAudit && <div className="mt-1 text-[10px] text-amber-200">Forward validation: momentum-qualified {intelligenceAudit.eligibleHits}/{intelligenceAudit.eligibleTrials} ({intelligenceAudit.eligibleTrials?(100*intelligenceAudit.eligibleHits/intelligenceAudit.eligibleTrials).toFixed(1):'0.0'}%; lower 95% {(100*intelligenceAudit.eligibleLower95).toFixed(1)}%). Entropy regimes: {(['LOW','MID','HIGH'] as const).map(k=>`${k} ${intelligenceAudit.regimes[k].hits}/${intelligenceAudit.regimes[k].trials} (${(100*intelligenceAudit.regimes[k].rate).toFixed(1)}%)`).join(' · ')}. Lower log loss is better; uniform baseline {intelligenceAudit.uniformLogLoss.toFixed(3)}.</div>}
    <p className="mt-1 text-[10px] text-slate-400">Optional evidence gate: when enabled, the bot waits for 150 eligible V1 next-tick observations and a 95% lower confidence bound above 10%. This is not proof of profitability; quoted break-even may be much higher. Demo-test before any live trading.</p>
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





type Ledger={day:string;account:string;attempts:number;profit:number;uncertain:boolean};
const dayUTC=()=>new Date().toISOString().slice(0,10);
const storageKey=(account:string)=>`dms-differs-v1:${account}:${dayUTC()}`;
const readLedger=(account:string):Ledger=>{
 const fresh={day:dayUTC(),account,attempts:0,profit:0,uncertain:false};
 try{const raw=localStorage.getItem(storageKey(account));if(!raw)return fresh;const v=JSON.parse(raw);if(v.day===fresh.day&&v.account===account&&Number.isInteger(v.attempts)&&v.attempts>=0&&Number.isFinite(v.profit))return {...fresh,...v}}catch{}
 return fresh;
};
const persist=(ledger:Ledger)=>{try{localStorage.setItem(storageKey(ledger.account),JSON.stringify(ledger))}catch{}};
const digitOf=(tick:Tick,pipSize:number)=>{
 const p=Number.isInteger(pipSize)&&pipSize>=0&&pipSize<=12?pipSize:2;
 return Number(tick.quote.toFixed(p).slice(-1));
};
function DigitDiffersStrategy({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,onBusyChange}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;onBusyChange:(busy:boolean)=>void}){
 const [stake,setStake]=useState('50');
 const [dailyLoss,setDailyLoss]=useState('250');
 const [minObservations,setMinObservations]=useState('100');
 const [notice,setNotice]=useState<TradeNotice|null>(null);
 const dismissNotice=useCallback(()=>setNotice(null),[]);
 const [enabled,setEnabled]=useState(false);
 const [liveApproved,setLiveApproved]=useState(false);
 const [ledger,setLedger]=useState<Ledger|null>(null);
 const [status,setStatus]=useState('Stopped');
 const [error,setError]=useState('');
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
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));
 const isLive=Boolean(accountId)&&!demo;
 const update=(v:Ledger)=>{latestLedger.current=v;setLedger(v);persist(v)};
 const stop=useCallback((message:string)=>{enabledRef.current=false;setEnabled(false);setStatus(message)},[]);
 useEffect(()=>{
  stop('Stopped — account or market changed');busy.current=false;uncertain.current=false;history.current=[];lastTick.current='';setRecent([]);setSelected(null);setLiveApproved(false);
  if(accountId){const l=readLedger(accountId);latestLedger.current=l;setLedger(l);uncertain.current=l.uncertain}else{latestLedger.current=null;setLedger(null)}
  session.current=`${accountId??''}:${symbol}`;
 },[accountId,symbol,stop]);
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
  if(l.attempts>=5){stop('Daily limit: 5 purchases');return}
  const amount=Number(stake),maxLoss=Number(dailyLoss),minimum=Number(minObservations);
  if(!Number.isFinite(amount)||amount<50||!Number.isFinite(maxLoss)||maxLoss<amount||!Number.isInteger(minimum)||minimum<20){stop('Invalid risk or signal settings');return}
  if(l.profit-amount < -maxLoss){stop('Daily loss exposure limit');return}
  if(arr.length<minimum){setStatus(`Warming up: ${arr.length}/${minimum} ticks`);return}
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
  // Simple selective check: require the chosen digit to occur less often than
  // the uniform 10% baseline in a separate validation window. This is not
  // statistically verified predictive power or a guarantee of profitability.
  if(valHits/validation.length>=0.1){setStatus(`Waiting: digit ${target} validation frequency ${(100*valHits/validation.length).toFixed(1)}% is not below 10%`);return}
  if(isLive&&!liveApproved){stop('Live account requires explicit confirmation');return}
  // Reserve a purchase slot synchronously BEFORE sending the buy request.
  busy.current=true;
  const reserved={...l,attempts:l.attempts+1};update(reserved);
  setStatus(`Submitting DIGITDIFF barrier ${target} (${reserved.attempts}/5)`);
  const entrySession=session.current;
  void (async()=>{
   try{
    const result=await ws.send<any>({buy:'1',price:Number((amount*1.05).toFixed(2)),parameters:{amount,basis:'stake',contract_type:'DIGITDIFF',currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,barrier:String(target)}});
    const id=Number(result?.buy?.contract_id);
    if(!Number.isSafeInteger(id)||id<=0)throw new Error('Purchase acknowledgment missing contract ID');
    setStatus(`Contract ${id}: waiting for broker settlement`);
    const c=await monitor(id,ws);
    const profit=Number(c?.profit);
    if(!Number.isFinite(profit))throw new Error('Settlement has no valid profit value');
    // Avoid applying an old account's outcome to a new account's ledger.
    const current=latestLedger.current;
    if(session.current===entrySession&&current&&current.account===accountId&&current.day===reserved.day){
     const next={...current,profit:Number((current.profit+profit).toFixed(2))};update(next);
     setStatus(`Settled: ${profit>=0?'WIN':'LOSS'} ${profit.toFixed(2)} USD · ${next.attempts}/5`);
     setNotice({id:Date.now(),contractId:id,profit,kind:profit>0?'WIN':'LOSS'});
     if(next.attempts>=5||next.profit<=-maxLoss)stop('Daily risk/trade limit reached');
    }
   }catch(e){
    const current=latestLedger.current;
    if(session.current===entrySession&&current&&current.account===accountId){update({...current,uncertain:true});uncertain.current=true;stop('Uncertain order or settlement — trading halted');setError(e instanceof Error?e.message:String(e))}
   }finally{busy.current=false}
  })();
 },[accountId,currentTick,dailyLoss,isConnected,isLive,liveApproved,minObservations,monitor,pipSize,stake,stop,symbol,ws]);
 const start=()=>{
  setError('');if(!accountId||!ws||!isConnected){setError('Connect your Deriv account first');return}
  const l=readLedger(accountId);update(l);
  if(l.uncertain){setError('An earlier purchase has uncertain status. Reconcile it in Deriv before continuing.');return}
  if(l.attempts>=5){setError('Five trades already attempted today (UTC).');return}
  if(isLive&&!liveApproved){setError('Confirm live trading first.');return}
  if(Number(stake)<50||!Number.isFinite(Number(stake))||Number(dailyLoss)<Number(stake)||(!Number.isInteger(Number(minObservations))||Number(minObservations)<20)){setError('Invalid settings: stake ≥ $50, loss cap ≥ stake, minimum ticks ≥ 20.');return}
  enabledRef.current=true;setEnabled(true);setStatus('Monitoring ticks for qualifying signal');
 };
 return <section className="rounded-xl border border-slate-600 p-4 space-y-3 text-sm">
  <div className="flex justify-between gap-2"><h3 className="font-bold text-lg">Selective Digit Differs</h3><span>{demo?'DEMO':isLive?'LIVE':'DISCONNECTED'}</span></div>
  <p>At most five $50+ one-tick DIGITDIFF purchases per UTC day. Entry requires a candidate digit to appear below 10% in the held-out sample; this does not prove a trading edge.</p>
  <div className="grid grid-cols-2 gap-2">
   <label>Stake USD<input className="block w-full rounded border bg-transparent p-2" type="number" min="50" step="0.01" value={stake} disabled={enabled} onChange={e=>setStake(e.target.value)}/></label>
   <label>Daily loss cap USD<input className="block w-full rounded border bg-transparent p-2" type="number" min="50" step="0.01" value={dailyLoss} disabled={enabled} onChange={e=>setDailyLoss(e.target.value)}/></label>
   <label>Minimum ticks<input className="block w-full rounded border bg-transparent p-2" type="number" min="20" step="1" value={minObservations} disabled={enabled} onChange={e=>setMinObservations(e.target.value)}/></label>
  </div>
  {isLive&&<label className="flex gap-2"><input type="checkbox" checked={liveApproved} disabled={enabled} onChange={e=>setLiveApproved(e.target.checked)}/> I understand these are real-money $50+ trades and authorize live execution.</label>}
  <div className="flex gap-2"><button className="rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-40" disabled={enabled||busy.current||!isConnected} onClick={start}>Start selective bot</button><button className="rounded bg-slate-600 px-4 py-2 text-white" onClick={()=>stop('Stopped — existing contract will still settle')}>Stop</button></div>
  <p>Today: <strong>{ledger?.attempts??0}/5</strong> attempted · Realized P/L <strong className={`font-black tabular-nums ${(ledger?.profit??0)>0?'text-green-400':(ledger?.profit??0)<0?'text-red-400':'text-slate-100'}`}>{(ledger?.profit??0)>0?'PROFIT ': (ledger?.profit??0)<0?'LOSS ':''}{(ledger?.profit??0)>=0?'+':'−'}${Math.abs(ledger?.profit??0).toFixed(2)}</strong> · Candidate digit: {selected??'—'}</p>
  <SettlementToast notice={notice} onDismiss={dismissNotice}/>
  <p>Status: {status}</p>{error&&<p role="alert" className="text-red-500">{error}</p>}
  <p className="text-xs opacity-75">Daily ledger is browser-local, not synchronized across devices. Do not run multiple bot tabs or instances. An uncertain order blocks further trading until manually reconciled. Stopping does not cancel a submitted purchase.</p>
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
