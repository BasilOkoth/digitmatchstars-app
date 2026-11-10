'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {getLastDigit} from '@/lib/digit-stats';
import {scoreDigits} from '@/lib/digitmatch-score';
import {NextTickIntelligence} from '@/lib/next-tick-intelligence';
import {ExecutionAwareForecast} from '@/lib/execution-aware-forecast';
import {SoonForecastAudit, type SoonHorizon} from '@/lib/soon-forecast';
import {useExecutionTarget,useEngineForecast} from './digit-stats-bar';
import type {Tick,DerivWS} from '@deriv/core';

type Mode='IDLE'|'RUNNING'|'BUYING'|'SETTLING'|'WIN'|'MAX_TRADES'|'MAX_LOSS'|'UNCERTAIN'|'STOPPED';
type Outcome={id:number;digit:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS';expiryDigit:number|null;expiryEpoch:number|null;signalEpoch:number;purchaseEpoch:number|null};
type Strategy='DYNAMIC'|'MOMENTUM_LOCK';
type EntryKind='NEXT'|'SOON';
type TickDecision={sequence:number;epoch:number;observedDigit:number;target:number|null;lockOriginSequence:number|null;status:'ELIGIBLE'|'SENT'|'ACCEPTED'|'SETTLED'|'SKIPPED'|'REJECTED'|'UNCERTAIN';reason:string;contractId:number|null;entryDigit?:number|null;entryEpoch?:number|null;expiryDigit?:number|null;expiryEpoch?:number|null;result?:'WIN'|'LOSS';at:string};
type FrozenEntryTrace={strategy:Strategy;lockSource:EntryKind|null;signalKind:EntryKind;target:number;nextDigit:number|null;soonDigit:number|null;soonLockedDigit:number|null;soonHorizon:number|null;signalSequence:number;signalEpoch:number;signalObservedDigit:number;signalReceivedAtIso:string;momentum:number;score:number;positiveSteps:number;forecastProbability:number|null;lockRemainingTicks:number|null;tradingLockOriginSequence:number|null;tradingLockOriginEpoch:number|null;tradingLockOriginDigit:number|null};
type MomentumTrade = {frozenTrace?:FrozenEntryTrace;verifiedExpiryMatchesTarget?:boolean|null;entryVsSignalSeconds?:number|null;expiryVsSignalSeconds?:number|null;entryKind?:EntryKind;soonHorizon?:number;entryDelayTicks?:number|null;strategy?:Strategy;lockTick?:number;lockDuration?:number;signalEpoch?:number;purchaseEpoch?:number|null;expiryEpoch?:number|null;expiryDigit?:number|null;signalSequence?:number;signalToSubmitMs?:number;buyAcknowledgmentMs?:number;ticksDuringAcknowledgment?:number;signalAgeBudgetMs?:number;entryEpoch?:number|null;entryDigit?:number|null;entrySpot?:string|null;exitSpot?:string|null;recordType:'TRADE';contractId:number;accountId:string;symbol:string;timestamp:string;targetDigit:number;score:number;momentum3:number;positiveSteps:number;momentumRising:boolean;threshold:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};
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
 const {publishForecast} = useEngineForecast();
 const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
 const [strategy,setStrategy]=useState<Strategy>('DYNAMIC');const [lockDuration,setLockDuration]=useState('5');const [tradeTicks,setTradeTicks]=useState('5');
 const lockPurchases=useRef(new Map<number,number>());
 const lockRef=useRef<{digit:number;elapsed:number;source:EntryKind;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number};originSequence:number;originEpoch:number}|null>(null);
 const [lockPosition,setLockPosition]=useState(0);
 const [tradeLockView,setTradeLockView]=useState<{digit:number;source:EntryKind;elapsed:number}|null>(null);
 const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('6');const [minMomentum,setMinMomentum]=useState('0');
 const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
 const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
 const scoreHistoryRef=useRef<Record<number,number>[]>([]);
 const intelligenceRef=useRef(new NextTickIntelligence());
 const soonAuditRef=useRef(new SoonForecastAudit());
 const [soonView,setSoonView]=useState<{digit:number;horizon:SoonHorizon;momentum:number;rate:number;trials:number}|null>(null);
 const [entrySignal,setEntrySignal]=useState<EntryKind|null>(null);
 const [lastTrace,setLastTrace]=useState<{trace:FrozenEntryTrace;contractId:number;entryDigit:number|null;expiryDigit:number|null;profit:number;outcome:'WIN'|'LOSS';entryEpoch:number|null;expiryEpoch:number|null}|null>(null);
 // A SOON signal stays frozen for its measured arrival window. Refreshing a
 // forecast cannot silently extend the window or change its target.
 const soonLockRef=useRef<{digit:number;createdSequence:number;expiresSequence:number;horizon:SoonHorizon}|null>(null);
 const [soonLockView,setSoonLockView]=useState<string|null>(null);
 const [entryTimingView,setEntryTimingView]=useState<string|null>(null);
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
 // Tick-paced execution telemetry is independent of React render timing.
 const paceRef=useRef({eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0});
 const [paceView,setPaceView]=useState({eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0});
 const tickLedger=useRef(new Map<number,TickDecision>());
 const [ledgerView,setLedgerView]=useState<TickDecision[]>([]);
 const publishLedger=()=>setLedgerView([...tickLedger.current.values()].slice(-30).reverse());
 const recordTick=(sequence:number,epoch:number,observedDigit:number,status:TickDecision['status'],reason:string,target:number|null=null,lockOriginSequence:number|null=null,contractId:number|null=null)=>{
   const prior=tickLedger.current.get(sequence);
   tickLedger.current.set(sequence,{sequence,epoch,observedDigit,target:target??prior?.target??null,lockOriginSequence:lockOriginSequence??prior?.lockOriginSequence??null,status,reason,contractId:contractId??prior?.contractId??null,at:new Date().toISOString()});
   while(tickLedger.current.size>250){const oldest=tickLedger.current.keys().next().value;if(oldest===undefined)break;tickLedger.current.delete(oldest)}
   queueMicrotask(publishLedger);
 };
 const publishPace=()=>{const v=paceRef.current;setPaceView({...v})};
 const skipPace=(reason:string)=>{const seq=tickSequence.current;const prior=tickLedger.current.get(seq);if(prior&&prior.status==='SKIPPED')recordTick(seq,prior.epoch,prior.observedDigit,'SKIPPED',reason,lockRef.current?.digit??null,lockRef.current?.originSequence??null);paceRef.current.skipped++;paceRef.current.lastSkip=reason;queueMicrotask(publishPace)};

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
 const stop=useCallback(()=>{halt.current=true;active.current=false;setTarget(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);setMode(m=>m==='RUNNING'?'STOPPED':m)},[setTarget]);
 useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];intelligenceRef.current.reset();soonAuditRef.current.reset();soonLockRef.current=null;setSoonLockView(null);setEntryTimingView(null);setSoonView(null);setEntrySignal(null);setLastTrace(null);executionForecastRef.current.reset();setLastTiming(null);setExecutionAudit(null);setHorizonTarget(null);setHorizonProbability(null);setIntelligenceAudit(null);nextTickPending.current=null;eligibleResults.current=[];setAccuracyAudit({trials:0,hits:0,lower95:0});if(!unsettled)confirmedLosses.current=0;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setTopMomentum(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);lockedRef.current=null;if(!unsettled){countRef.current=0;setSentCount(0);lossBlockRef.current=0;pnlRef.current=0;}if(!unsettled){pending.current=false;pendingCount.current=0;inFlight.current.clear();matchPause.current=false;setMatchPaused(false);setInFlightCount(0);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';if(!unsettled)matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0};setPaceView({...paceRef.current});tickLedger.current.clear();setLedgerView([]);tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0};setPaceView({...paceRef.current});setHistory([]);setScores([]);setLockedDigit(null);setTarget(null);setCount(0);setPnl(0);setLossBlock(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv before restarting.');else setErr('')}},[scopeKey,setTarget]);
 const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,firstLockMatch:boolean,entryKind:EntryKind,soonHorizon:number|null,frozenTrace:FrozenEntryTrace)=>{
  if(!ws||!accountId||halt.current||!active.current||winConfirmed.current||uncertainPurchase.current||matchPause.current||countRef.current>=Number(limit))return;
  // Never replay ticks skipped while a previous buy was in flight.
  if(signalSequence<=lastBuySignalSequence.current){recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Duplicate dispatch prevented',predicted,frozenTrace.tradingLockOriginSequence);return;}
  // Reserve a distinct slot for this tick. No waiting for previous settlement.
  if(inFlight.current.has(signalSequence)){recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Purchase already pending for tick',predicted,frozenTrace.tradingLockOriginSequence);return;}
  pendingCount.current++;
  pending.current=true;
  inFlight.current.set(signalSequence,{digit:predicted,stake});
  refreshExposure();
  // Defer visual state changes until after the irreversible request is sent.
  let contractId:number|undefined;let purchaseAttempted=false;
  // Reserve this risk immediately so a later tick cannot exceed the cycle budget.
  reservedStake.current=amount(reservedStake.current+stake);refreshExposure();
  try{
   if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
   // Both Demo and Real use the same one-request Deriv buy. One tick can
   // trigger at most one irreversible purchase; the WS acknowledgement is
   // never interpreted as an already-settled WIN.
   if(tickSequence.current!==signalSequence || signalSequence<=lastBuySignalSequence.current || halt.current || matchPause.current){
     tickStats.current.staleQuotes++;
     recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Tick changed or match hold before send',predicted,frozenTrace.tradingLockOriginSequence);
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     setMode(outstanding.current.size?'SETTLING':'RUNNING');
     return;
   }
   // The observed tick is historical by the time a BUY reaches Deriv.
   // Do not suppress a fresh purchase merely because that observed digit
   // equals the target. It cannot retroactively win on the observed tick.
   // The existing separate match-hold protects outstanding contracts.
   if(tickSequence.current!==signalSequence){
    reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
    recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Newer tick arrived before send',predicted,frozenTrace.tradingLockOriginSequence);
    setEntryStatus('Newer tick arrived before dispatch · waiting for fresh signal');
    setMode('RUNNING');
    return;
   }
   const elapsedMs=performance.now()-signalReceivedAt;
   // Reject signals that are already a substantial fraction of a tick old.
   // This is a latency guard, not a promise about Deriv's eventual entry tick.
   const freshnessBudgetMs=Math.max(100,Math.min(350,(tickCadence.current.intervalMs??1000)*0.35));
   if(elapsedMs>freshnessBudgetMs){
    tickStats.current.staleQuotes++;
    reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
    recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Signal exceeded freshness budget',predicted,frozenTrace.tradingLockOriginSequence);
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
   // Dispatch before updating React state. This returns a promise and normally
   // writes to the existing open WebSocket synchronously.
   const buyPromise=ws.send<any>({
     buy:'1', price:amount(stake*1.05),
     parameters:{amount:stake,basis:'stake',contract_type:'DIGITMATCH',
       currency:'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,
       barrier:String(predicted)},
   });
   paceRef.current.dispatched++;
   recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SENT','Purchase request submitted',predicted,frozenTrace.tradingLockOriginSequence);
   paceRef.current.lastDispatchSequence=signalSequence;
   queueMicrotask(publishPace);
   setMode('BUYING');
   setDispatchTiming(old=>({signalToSubmitMs,acknowledgmentMs:old?.acknowledgmentMs??0,ticksDuringAck:old?.ticksDuringAck??0}));
   const bought=await buyPromise;
   const buyMs=Math.round(performance.now()-buyStart);
   const ticksDuringAcknowledgment=Math.max(0,tickSequence.current-signalSequence);
   setEntryTimingView(`${entryKind} target ${predicted} · dispatch ${signalToSubmitMs} ms · ACK ${buyMs} ms / ${ticksDuringAcknowledgment} observed ticks · entry pending verification`);
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
   recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'ACCEPTED','Deriv acknowledged contract',predicted,frozenTrace.tradingLockOriginSequence,contractId);
   paceRef.current.accepted++;queueMicrotask(publishPace);
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
     setLastTrace({trace:frozenTrace,contractId:id,entryDigit,expiryDigit,profit,outcome:win?'WIN':'LOSS',entryEpoch,expiryEpoch});
     const ledgerRow=tickLedger.current.get(signalSequence);
     if(ledgerRow){tickLedger.current.set(signalSequence,{...ledgerRow,status:'SETTLED',reason:`Deriv ${win?'WIN':'LOSS'} ${profit>=0?'+':''}$${profit.toFixed(2)}`,entryDigit,entryEpoch,expiryDigit,expiryEpoch,result:win?'WIN':'LOSS',contractId:id});queueMicrotask(publishLedger)}
     setEntryTimingView(`${entryKind} #${id} · dispatch ${signalToSubmitMs} ms · ACK ${buyMs} ms / ${ticksDuringAcknowledgment} ticks · entry ${entryDigit??'unknown'} · expiry ${expiryDigit??'unknown'} · ${win?'WIN':'LOSS'}`);
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
     setLastOutcome(old=>old?.outcome==='WIN'&&!win?old:{id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS',expiryDigit,expiryEpoch,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});play(win?'win':'loss');
     const journalRow:MomentumTrade={frozenTrace,verifiedExpiryMatchesTarget:expiryDigit===null?null:expiryDigit===predicted,entryVsSignalSeconds:entryEpoch===null?null:entryEpoch-tickEpoch,expiryVsSignalSeconds:expiryEpoch===null?null:expiryEpoch-tickEpoch,entryKind,soonHorizon:entryKind==='SOON'?soonHorizon??undefined:undefined,entryDelayTicks:entryEpoch===null?null:Math.max(0,entryEpoch-tickEpoch),signalSequence,signalToSubmitMs,ticksDuringAcknowledgment,signalAgeBudgetMs:Math.max(100,Math.min(350,(tickCadence.current.intervalMs??1000)*0.35)),buyAcknowledgmentMs:Math.round(acknowledgedAt-buyStart),entryEpoch,entryDigit,entrySpot:entrySpot===null?null:String(entrySpot),exitSpot:settle.exit_spot===undefined?null:String(settle.exit_spot),strategy:entryStrategy,lockTick,lockDuration:lockWindow,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch,expiryEpoch,expiryDigit,recordType:'TRADE',contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,momentumRising:signal.momentum3>0&&signal.positiveSteps>=2,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'};
     try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:MomentumTrade)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
     // Settlement runs in the background; only confirmed settlement frees the slot.
     if(matchPause.current)setEntryStatus('Matched tick observed · verifying all unsettled contracts');
     outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);refreshExposure();
     if(win){winConfirmed.current=true;halt.current=true;active.current=false;matchPause.current=false;setMatchPaused(false);lockedRef.current=null;lockRef.current=null;setLockedDigit(null);setLockPosition(0);setTradeLockView(null);setTarget(null);setTargetScore(null);setTargetMomentum(null);setTargetProbability(null);setTargetRises(null);setMode('WIN')}
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
   if(purchaseAttempted){recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'UNCERTAIN',String(e),predicted,frozenTrace.tradingLockOriginSequence,contractId??null);uncertainPurchase.current=true;setMode('UNCERTAIN');setErr(`Purchase status unknown: ${String(e)}. Reconcile in Deriv.`)}
   else{recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED',String(e),predicted,frozenTrace.tradingLockOriginSequence);reservedStake.current=Math.max(0,amount(reservedStake.current-stake));setMode('STOPPED');setErr(`No trade was purchased: ${String(e)}`)}
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
   recordTick(sequence,epoch,digit,'SKIPPED','Processing tick');
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
   // LOW-LATENCY LOCK PATH: a previously acquired Momentum Lock needs no
   // forecasting or score recalculation before submitting its next order.
   // Dispatch first, then run the normal analytics for this observed tick.
   const fastLock=lockRef.current;
   const fastLockTick=fastLock?fastLock.elapsed+1:0;
   if(settings.strategy==='MOMENTUM_LOCK' && fastLock &&
      fastLockTick<=Number(settings.lockDuration) &&
      active.current && !halt.current && !uncertainPurchase.current &&
      !matchPause.current && settings.isConnected && settings.accountId &&
      countRef.current<Number(settings.limit) &&
      sequence>lastBuySignalSequence.current &&
      (lockPurchases.current.get(fastLock.originSequence)??0)<Math.min(30,Math.max(1,Number(tradeTicks)||1))){
     const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
     const trials=eligibleResults.current.length;
     const hits=eligibleResults.current.reduce((sum,hit)=>sum+hit,0);
     const evidenceOK=!requireEvidence||(trials>=150&&wilsonLower(hits,trials)>0.1);
     const riskOK=Number.isFinite(stake)&&stake>0 &&
       stake+reservedStake.current+Math.max(0,-pnlRef.current)<=Number(settings.maxLoss);
     if(evidenceOK&&riskOK){
       const priorRanking=scoreRef.current;
       const priorTarget=priorRanking.find(row=>row.digit===fastLock.digit)??null;
       const frozenTrace:FrozenEntryTrace={
         strategy:'MOMENTUM_LOCK',lockSource:fastLock.source,signalKind:fastLock.source,
         target:fastLock.digit,nextDigit:priorRanking[0]?.digit??null,
         soonDigit:soonLockRef.current?.digit??null,
         soonLockedDigit:soonLockRef.current?.digit??null,
         soonHorizon:soonLockRef.current?.horizon??null,
         signalSequence:sequence,signalEpoch:epoch,signalObservedDigit:digit,
         signalReceivedAtIso:new Date().toISOString(),
         momentum:fastLock.signal.momentum3,score:fastLock.signal.score,
         positiveSteps:fastLock.signal.positiveSteps,
         forecastProbability:null, // DigitScore does not expose a calibrated probability
         lockRemainingTicks:null,
         tradingLockOriginSequence:fastLock.originSequence,
         tradingLockOriginEpoch:fastLock.originEpoch,
         tradingLockOriginDigit:fastLock.digit,
       };
       paceRef.current.eligible++;
       recordTick(sequence,epoch,digit,'ELIGIBLE','Fast path: active Momentum Lock',fastLock.digit,fastLock.originSequence);
       // execute() calls ws.send before its first await; settlements remain async.
       const previousCount=countRef.current;
       void execRef.current(fastLock.digit,stake,fastLock.signal,epoch,sequence,
         receivedAt,'MOMENTUM_LOCK',fastLockTick,Number(settings.lockDuration),
         false,fastLock.source,null,frozenTrace);
       if(countRef.current>previousCount)lockPurchases.current.set(fastLock.originSequence,(lockPurchases.current.get(fastLock.originSequence)??0)+1);
       queueMicrotask(publishPace);
     }
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
   // Grade previously frozen SOON signals before creating any new forecast.
   soonAuditRef.current.observe(digit);
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
   // NEXT is the highest one-tick probability candidate. SOON is independently
   // ranked by positive score momentum, rising steps and forecast probability.
   // SOON's horizon measures appearance within N ticks; it does NOT predict
   // the expiry digit of a one-tick Deriv contract.
   const qualified=ranking.filter(row=>Number.isFinite(row.score) && row.score>=Number(settings.threshold) &&
     row.momentum3>0 && row.momentum3>=Number(settings.minMomentum) && row.positiveSteps>=2);
   const soonCandidate=[...qualified].sort((a,b)=>
     (b.momentum3+4*b.probability)-(a.momentum3+4*a.probability) || a.digit-b.digit)[0]??null;
   const soonHorizon:SoonHorizon=soonCandidate && soonCandidate.positiveSteps===3 && soonCandidate.momentum3>=6 ? 3 :
     soonCandidate && soonCandidate.positiveSteps===3 ? 4 :
     soonCandidate && soonCandidate.momentum3>=3 ? 5 : 10;
   if(soonCandidate){
     soonAuditRef.current.freeze(soonCandidate.digit,soonHorizon);
     const stats=soonAuditRef.current.stats(soonHorizon);
     if(sequence%5===0)queueMicrotask(()=>setSoonView({digit:soonCandidate.digit,horizon:soonHorizon,momentum:soonCandidate.momentum3,rate:stats.trials?stats.hits/stats.trials:0,trials:stats.trials}));
   }
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
       selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);
     } else {lockRef.current=selected;setLockPosition(selected.elapsed);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:selected.elapsed})}
   }else if(settings.strategy!=='MOMENTUM_LOCK' && selected){
     lockRef.current=null;selected=null;setLockPosition(0);setTradeLockView(null);
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
   if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected){
     recordTick(sequence,epoch,digit,'SKIPPED',!active.current?'Cycle inactive':halt.current?'Cycle halted':uncertainPurchase.current?'Uncertain purchase':!settings.accountId?'No account':'Disconnected',lockRef.current?.digit??null,lockRef.current?.originSequence??null);return;
   }
   if(matchPause.current){skipPace('Match hold: awaiting Deriv settlement');setEntryStatus(`MATCH HOLD · ${outstanding.current.size} confirmed + ${pendingCount.current} pending contracts; await Deriv settlement`);return;}
   if(!ranking.length){skipPace('Forecast warming up');setEntryStatus('V1 warming up');return}
   if(countRef.current>=Number(settings.limit)){skipPace('Max trades reached');halt.current=true;active.current=false;setMode('MAX_TRADES');setEntryStatus('Max trades reached');return}
   // Both NEXT and SOON can qualify independently on EVERY fresh tick.
   // In Momentum Lock, NEXT and SOON only select the initial digit.
   // Once selected, every eligible purchase uses that frozen digit.
   const nextCandidate=top && qualified.some(row=>row.digit===top.digit)?top:null;
   // Keep a SOON target for its ORIGINAL horizon; do not reset its expiry on
   // every tick. A new target can only be created after expiry or invalidation.
   let soonLock=soonLockRef.current;
   if(soonLock && (sequence>soonLock.expiresSequence || digit===soonLock.digit)){
     soonLock=null;soonLockRef.current=null;
   }
   if(!soonLock && soonCandidate && digit!==soonCandidate.digit){
     soonLock={digit:soonCandidate.digit,createdSequence:sequence,expiresSequence:sequence+soonHorizon,horizon:soonHorizon};
     soonLockRef.current=soonLock;
   }
   if(sequence%3===0){
     const label=soonLock?`SOON lock ${soonLock.digit} · ${Math.max(0,soonLock.expiresSequence-sequence)} ticks left`:'No active SOON lock';
     queueMicrotask(()=>setSoonLockView(label));
   }
   // NEXT has priority if qualified. Otherwise the still-valid SOON lock
   // gets an opportunity on EACH fresh tick, subject to current momentum,
   // exposure, stale-signal and match-hold safety gates.
   const lockedSoonCandidate=soonLock?ranking.find(row=>row.digit===soonLock.digit)??null:null;
   const choice=nextCandidate??lockedSoonCandidate;
   const choiceKind:EntryKind=nextCandidate?'NEXT':'SOON';
   if(!choice && !(settings.strategy==='MOMENTUM_LOCK' && selected)){skipPace('No qualifying signal');setEntryStatus('No qualified NEXT or active SOON target');return}
   if(settings.strategy==='MOMENTUM_LOCK' && !selected && choice){
     selected={digit:choice.digit,elapsed:1,source:choiceKind,originSequence:sequence,originEpoch:epoch,signal:{score:choice.score,momentum3:choice.momentum3,positiveSteps:choice.positiveSteps,threshold:Number(settings.threshold)}};
     lockRef.current=selected;setLockPosition(1);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:1});
   }
   // Optional gate tests the actual V1 next-tick candidate, rather than a
   // different, horizon-optimized digit. The contract break-even rate may be
   // much higher than the 10% uniform random-digit baseline.
   if(requireEvidence && (eligibleResults.current.length<150 ||
       wilsonLower(eligibleResults.current.reduce((a,b)=>a+b,0),eligibleResults.current.length)<=0.1)){
     skipPace('Evidence gate');setEntryStatus(`V1 evidence gate: ${eligibleResults.current.length}/150; lower bound must exceed 10%`);
     return;
   }
   const target=settings.strategy==='MOMENTUM_LOCK'?selected!.digit:choice!.digit;
   const chosenForecast=ranking.find(row=>row.digit===target);
   if(!chosenForecast){skipPace('Target unavailable');setEntryStatus('V1 target unavailable');return}
   const ownMomentum=chosenForecast.momentum3;
   const ownRises=chosenForecast.positiveSteps;
   const ownRising=ownMomentum>0 && ownMomentum>=Number(settings.minMomentum) && ownRises>=2;
   // Momentum Lock qualification occurs ONLY when acquiring the lock above.
   // During the active lock, do not re-qualify its frozen digit on each tick:
   // a later momentum change must not silently suppress tick-paced purchases.
   // Dynamic V1 still applies the live score/rising-momentum gate per tick.
   if(settings.strategy!=='MOMENTUM_LOCK' &&
      (chosenForecast.score<Number(settings.threshold) || !ownRising)){
     skipPace('Score or rising momentum gate');
     setEntryStatus(`Dynamic V1 ${target}: score ${chosenForecast.score.toFixed(2)}/${settings.threshold} · momentum ${ownMomentum.toFixed(2)}/${settings.minMomentum} · rises ${ownRises}/3; awaiting qualification`);
     return;
   }
   // Deliberately do not reject V1 purely for an uncalibrated 10% probability
   // estimate. Such thresholds are evaluated offline against actual outcomes.
   const signal={score:chosenForecast.score,momentum3:ownMomentum,positiveSteps:ownRises,threshold:Number(settings.threshold)};
   const signalKind:EntryKind=settings.strategy==='MOMENTUM_LOCK'?selected!.source:choiceKind;
   const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
   // Do not skip just because the observed tick equals the target:
   // that tick has already occurred and the new contract will enter later.
   // An actual pending-contract match still activates the independent
   // settlement-verification hold earlier in this callback.
   // Send only from a fresh, nonmatching observed tick. Settlement is
   // exclusively determined by Deriv, asynchronously after the BUY acknowledgment.
   const firstLockMatch=false;
   // Do NOT wait for ACK/settlement: each fresh tick has its own dispatch.
   // Execute at most one purchase on a fresh signal; require settlement and then a new tick.
   if(sequence<=lastBuySignalSequence.current){return} // Fast path already submitted this tick.
   if(settings.strategy==='MOMENTUM_LOCK' && selected && (lockPurchases.current.get(selected.originSequence)??0)>=Math.min(30,Math.max(1,Number(tradeTicks)||1))){skipPace('Trade Ticks limit reached for this lock');return}
   const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
   if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
    skipPace('Next stake would exceed loss limit');stop();setMode('MAX_LOSS');return;
   }
   // IMPORTANT: dispatch the request BEFORE any React state/context updates.
   // The executor reserves the tick and pending slot synchronously up to ws.send().
   lastSignalDispatchMs.current=receivedAt;
   lockedRef.current=target;
   queueMicrotask(()=>setEntrySignal(signalKind));
   // Freeze the exact model and lock state BEFORE sending the purchase.
   // Never reconstruct a past trade from the continuously changing dashboard.
   const frozenTrace:FrozenEntryTrace={
     strategy:settings.strategy,lockSource:settings.strategy==='MOMENTUM_LOCK'?selected!.source:null,
     signalKind,target,nextDigit:top?.digit??null,soonDigit:soonCandidate?.digit??null,
     soonLockedDigit:soonLockRef.current?.digit??null,
     soonHorizon:signalKind==='SOON'?soonLockRef.current?.horizon??null:null,
     signalSequence:sequence,signalEpoch:epoch,signalObservedDigit:digit,
     signalReceivedAtIso:new Date().toISOString(),momentum:ownMomentum,
     score:chosenForecast.score,positiveSteps:ownRises,
     forecastProbability:Number.isFinite(chosenForecast.probability)?chosenForecast.probability:null,
     lockRemainingTicks:soonLockRef.current?Math.max(0,soonLockRef.current.expiresSequence-sequence):null,
     tradingLockOriginSequence:settings.strategy==='MOMENTUM_LOCK'?selected?.originSequence??null:null,
     tradingLockOriginEpoch:settings.strategy==='MOMENTUM_LOCK'?selected?.originEpoch??null:null,
     tradingLockOriginDigit:settings.strategy==='MOMENTUM_LOCK'?selected?.digit??null:null,
   };
   paceRef.current.eligible++;
   recordTick(sequence,epoch,digit,'ELIGIBLE','Risk and signal gates passed',target,selected?.originSequence??null);
   queueMicrotask(publishPace);
   const previousCount=countRef.current;
   void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,settings.strategy==='MOMENTUM_LOCK'?Number(settings.lockDuration):0,firstLockMatch,signalKind,signalKind==='SOON'?soonLockRef.current?.horizon??null:null,frozenTrace);
   if(settings.strategy==='MOMENTUM_LOCK' && selected && countRef.current>previousCount)lockPurchases.current.set(selected.originSequence,(lockPurchases.current.get(selected.originSequence)??0)+1);
   queueMicrotask(()=>{
     if(scope.current!==telemetryScope)return;
     setLockedDigit(target);setTarget(target);
     setEntryStatus(`${signalKind} sent on tick ${sequence} · ${pendingCount.current} ACK pending / ${outstanding.current.size} settling`);
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
  lockPurchases.current.clear();matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');countRef.current=0;setSentCount(0);pnlRef.current=0;reservedStake.current=0;setRiskExposure(0);matchPause.current=false;setMatchPaused(false);confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTarget(null);setLastOutcome(null);setTargetScore(null);setTargetRises(null);setTargetMomentum(null);setTargetProbability(null);winConfirmed.current=false;setErr('');halt.current=false;active.current=true;setLastTiming(null);setMode('RUNNING');if(sound)tone('buy');
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
    {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Trade Ticks <input type="number" min="1" max="30" step="1" value={tradeTicks} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setTradeTicks(e.target.value)} className="w-14 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white" /></label>}
    {strategy==='MOMENTUM_LOCK'&&<span className="text-emerald-400">{tradeLockView?`Trading lock ${tradeLockView.digit} · ${tradeLockView.source} selection · tick ${tradeLockView.elapsed}/${lockDuration}`:'Waiting for rising momentum'}</span>}
  </div>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
  {strategy==='MOMENTUM_LOCK'&&<div className="mt-2 rounded-lg border border-emerald-500/30 bg-[#0a1721] p-2 text-xs" aria-label="Momentum Lock trading status" aria-live="polite">
    <div className="mb-1 font-bold text-emerald-300">Momentum Lock · trading target (separate from SOON research lock)</div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-200">
      <span>Active target <strong className="text-white">{tradeLockView?.digit??'—'}</strong></span>
      <span>Remaining <strong>{tradeLockView?Math.max(0,Math.max(1,Number(lockDuration)||1)-tradeLockView.elapsed+1):'—'}</strong> trading ticks</span>
      <span>Selected by <strong>{tradeLockView?.source??'—'}</strong></span>
      <span>Purchases this lock <strong>{lockRef.current?(lockPurchases.current.get(lockRef.current.originSequence)??0):0}/{tradeTicks}</strong></span>
      <span>Status <strong className={mode==='RUNNING'&&!matchPaused&&!winConfirmed.current?'text-emerald-300':'text-amber-300'}>{mode==='UNCERTAIN'?'RECONCILIATION REQUIRED':winConfirmed.current||mode==='WIN'?'WIN CONFIRMED · STOPPED':matchPaused?'MATCH HOLD · VERIFYING SETTLEMENT':mode!=='RUNNING'?'NOT TRADING':!tradeLockView?'WAITING FOR QUALIFIED LOCK':'ACTIVE · SAFETY GATES APPLY'}</strong></span>
    </div>
    <div className="mt-1 text-slate-400">{mode==='RUNNING'?`Latest execution decision: ${entryStatus}`:mode==='WIN'?'Cycle stopped after verified win. Start a new cycle to trade again.':`Purchases disabled: ${mode.toLowerCase().replace(/_/g,' ')}.`}</div>
    <div className="mt-1 text-slate-500">SOON appearance lock below is research-only; it does not replace the active trading target. ACTIVE means eligible ticks are evaluated, not that every tick will be purchased.</div>
  </div>}
  <div className="mt-2 rounded-md border border-slate-700/60 bg-[#091725] text-[11px] text-slate-200" aria-label="Advanced diagnostics">
    <details className="group">
      <summary className="cursor-pointer select-none px-2 py-1.5 font-semibold text-cyan-300">Advanced diagnostics <span className="font-normal text-slate-400">· contract trace, dispatch and tick ledger</span></summary>
      <div className="space-y-2 border-t border-slate-700/60 px-2 py-2">
    {lastTrace&&<div className="w-full rounded-md border border-slate-600 bg-[#0a1222] p-2 text-[11px]" aria-label="Frozen contract signal audit">
      <div className="font-bold text-cyan-300">Verified contract trace · #{lastTrace.contractId}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-slate-200">
        <span>Method {lastTrace.trace.strategy==='MOMENTUM_LOCK'?'Momentum Lock':'Dynamic V1'} · selection {lastTrace.trace.lockSource??lastTrace.trace.signalKind} · target <strong>{lastTrace.trace.target}</strong></span>
        <span>At signal: NEXT {lastTrace.trace.nextDigit??'—'} · SOON {lastTrace.trace.soonDigit??'—'} · SOON lock {lastTrace.trace.soonLockedDigit??'—'}</span>
        <span>Momentum {lastTrace.trace.momentum.toFixed(2)} · score {lastTrace.trace.score.toFixed(2)} · rises {lastTrace.trace.positiveSteps}/3</span>
        <span>Signal tick #{lastTrace.trace.signalSequence} · observed {lastTrace.trace.signalObservedDigit} · epoch {lastTrace.trace.signalEpoch}</span>
        <span>Deriv entry {lastTrace.entryDigit??'unknown'} · expiry {lastTrace.expiryDigit??'unknown'}</span>
        <span>Entry time {lastTrace.entryEpoch??'unknown'} · expiry time {lastTrace.expiryEpoch??'unknown'}</span>
        <strong className={lastTrace.profit>0?'text-green-400':'text-red-400'}>{lastTrace.outcome} {lastTrace.profit>=0?'+':''}${lastTrace.profit.toFixed(2)}</strong>
      </div>
      <div className="mt-1 text-slate-400">Frozen at dispatch. Deriv settlement determines WIN/LOSS; matching digits alone do not prove tick-level execution alignment.</div>
    </div>}
      <div>
    <span className="font-semibold text-cyan-300">Tick-paced dispatch</span>
    <span className="ml-2">Eligible <strong>{paceView.eligible}</strong></span>
    <span className="ml-2">Sent <strong>{paceView.dispatched}</strong></span>
    <span className="ml-2">Accepted <strong>{paceView.accepted}</strong></span>
    <span className="ml-2">Skipped <strong>{paceView.skipped}</strong></span>
    <span className="ml-2">Coverage <strong>{paceView.eligible?`${(100*paceView.dispatched/paceView.eligible).toFixed(1)}%`:'—'}</strong></span>
    <div className="text-slate-400">Last skipped: {paceView.lastSkip} · Last dispatched tick #{paceView.lastDispatchSequence||'—'} · {cadenceLabel}</div>
    <div className="text-slate-500">Sent means a request was submitted, not that Deriv entered on that exact tick. Accepted counts acknowledged contracts. Risk controls and confirmed wins intentionally prevent trading every market tick.</div>
    <div className="mt-1 font-semibold text-cyan-300">Recent tick-to-purchase ledger</div>
    <div className="max-h-60 overflow-y-auto font-mono text-[10px]" aria-label="Tick purchase ledger">{ledgerView.map(t=><div key={t.sequence} className="border-t border-slate-700/40 py-0.5">#{t.sequence} · market {t.observedDigit} · target {t.target??'—'} · lock from #{t.lockOriginSequence??'—'} · <strong className={t.status==='ACCEPTED'?'text-emerald-400':t.status==='UNCERTAIN'?'text-red-400':'text-slate-300'}>{t.status}</strong> · {t.reason}{t.contractId?` · #${t.contractId}`:''}{t.entryDigit!==undefined?` · entry ${t.entryDigit??'?'} @ ${t.entryEpoch??'?'}`:''}{t.expiryDigit!==undefined?` · expiry ${t.expiryDigit??'?'} @ ${t.expiryEpoch??'?'}`:''}</div>)}</div>
      </div>
      </div>
    </details>
  </div>
  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Next-tick top',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
    <span className={topMomentum===null?'text-slate-400':topMomentum>0?'font-bold text-emerald-400':'font-bold text-rose-400'}>
      Momentum {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)}`}
    </span>
    <span className="text-slate-300">{strategy==='MOMENTUM_LOCK' ? 'Locked target (next tick)' : 'V1 next-tick target'} {winConfirmed.current ? '—' : (strategy==='MOMENTUM_LOCK' ? tradeLockView?.digit ?? '—' : scores[0]?.digit ?? '—')}</span>
    {soonView&&<span className="text-sky-300">SOON {soonView.digit} · within {soonView.horizon} ticks · momentum +{soonView.momentum.toFixed(2)} · observed {soonView.trials?`${(soonView.rate*100).toFixed(1)}% / ${soonView.trials}`:'warming up'} (appearance, not contract win)</span>}
    {soonLockView&&<span className="text-cyan-300">{soonLockView}</span>}
    {entrySignal&&<span className="font-semibold text-white">Last entry: {strategy==='MOMENTUM_LOCK'?'Momentum Lock':'Dynamic V1'} · {entrySignal} selection</span>}
    {entryTimingView&&<span className="text-amber-200">Timing: {entryTimingView}</span>}
    <span className="text-slate-400">Open {outstandingCount} · ACK pending {inFlightCount} · At risk ${riskExposure.toFixed(2)}</span>
    {matchPaused && <strong className="text-yellow-300">MATCH HOLD · awaiting verified settlement</strong>}
    {active.current && <span className={/awaiting settlement/i.test(entryStatus) ? "font-semibold text-yellow-400" : "text-slate-400"}>{entryStatus}</span>}

    {mode==='UNCERTAIN'&&<span className="font-bold text-amber-300">Settlement needs verification</span>}
  </div>
  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/70 p-2 text-xs text-slate-300">
    <span>Measured next-tick accuracy: <strong className="text-white">{accuracyAudit.trials ? `${(100*accuracyAudit.hits/accuracyAudit.trials).toFixed(1)}%` : '—'}</strong> ({accuracyAudit.hits}/{accuracyAudit.trials})</span>
    <label className="flex items-center gap-1.5"><input type="checkbox" checked={requireEvidence} disabled={active.current || pending.current || outstandingCount>0} onChange={e=>setRequireEvidence(e.target.checked)} />Require measured edge</label>
  </div>
  <div className="mt-2 flex items-center gap-2">
    <button
      disabled={!active.current && (!valid||!accountId||!isConnected||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')}
      onClick={() => { if(active.current) stop(); else start(); }}
      className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}
    >{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
    <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
  </div>
  {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Contract #{lastOutcome.id} · target {lastOutcome.digit}</span></div>}
  {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}

 </div></section>
}
