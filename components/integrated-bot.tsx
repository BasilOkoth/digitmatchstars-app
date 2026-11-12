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
type EntryKind='NEXT';
type TickDecision={sequence:number;epoch:number;observedDigit:number;target:number|null;lockOriginSequence:number|null;status:'ELIGIBLE'|'SENT'|'ACCEPTED'|'SETTLED'|'SKIPPED'|'REJECTED'|'UNCERTAIN';reason:string;contractId:number|null;entryDigit?:number|null;entryEpoch?:number|null;expiryDigit?:number|null;expiryEpoch?:number|null;result?:'WIN'|'LOSS';at:string};
type FrozenEntryTrace={strategy:Strategy;lockSource:EntryKind|null;signalKind:EntryKind;target:number;nextDigit:number|null;signalSequence:number;signalEpoch:number;signalObservedDigit:number;signalReceivedAtIso:string;momentum:number;score:number;positiveSteps:number;forecastProbability:number|null;lockRemainingTicks:number|null;tradingLockOriginSequence:number|null;tradingLockOriginEpoch:number|null;tradingLockOriginDigit:number|null;
  horizonTicks?:number;horizonProbability?:number;horizonLift?:number;horizonRank?:number;horizonGapAtLock?:number;horizonGapExpectation?:number;
};
type MomentumTrade = {frozenTrace?:FrozenEntryTrace;verifiedExpiryMatchesTarget?:boolean|null;entryVsSignalSeconds?:number|null;expiryVsSignalSeconds?:number|null;entryKind?:EntryKind;soonHorizon?:number;entryDelayTicks?:number|null;strategy?:Strategy;lockTick?:number;lockDuration?:number;signalEpoch?:number;purchaseEpoch?:number|null;expiryEpoch?:number|null;expiryDigit?:number|null;signalSequence?:number;signalToSubmitMs?:number;buyAcknowledgmentMs?:number;ticksDuringAcknowledgment?:number;signalAgeBudgetMs?:number;entryEpoch?:number|null;entryDigit?:number|null;entrySpot?:string|null;exitSpot?:string|null;recordType:'TRADE';contractId:number;accountId:string;symbol:string;timestamp:string;targetDigit:number;score:number;momentum3:number;positiveSteps:number;momentumRising:boolean;threshold:number;stake:number;payout:number;profit:number;outcome:'WIN'|'LOSS'};

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

// ════════════════════════════════════════════════════════════════════════════
// DigitHorizonAnalyzer — empirical P(digit appears in next k ticks)
// ════════════════════════════════════════════════════════════════════════════
interface HorizonDigitScore {
  digit:number;
  horizonProbability:number;
  lift:number;
  rawGapSamples:number;
  gap:number;
  gapExpectation:number;
  overdueRatio:number;
  nextTickScore:number;
  combined:number;
}
interface PendingHorizon { frozenAtSeq:number; topDigit:number; expiresAtSeq:number; hit:boolean }
class DigitHorizonAnalyzer {
  private history:number[]=[];
  private gapsByDigit=new Map<number,number[]>();
  private lastSeenTick=new Map<number,number>();
  private totalObserved=0;
  private readonly maxHistory=500;
  private readonly maxGapsPerDigit=200;

  reset(){this.history=[];this.gapsByDigit.clear();this.lastSeenTick.clear();this.totalObserved=0}
  totalTicks(){return this.totalObserved}
  minGapSamples(){let m=Infinity;for(let d=0;d<10;d++){const n=this.gapsByDigit.get(d)?.length??0;if(n<m)m=n}return m===Infinity?0:m}

  observe(digit:number){
    const t=this.totalObserved;
    const last=this.lastSeenTick.get(digit);
    if(last!==undefined){
      const arr=this.gapsByDigit.get(digit)??[];
      arr.push(t-last);
      if(arr.length>this.maxGapsPerDigit)arr.shift();
      this.gapsByDigit.set(digit,arr);
    }
    this.lastSeenTick.set(digit,t);
    this.history.push(digit);
    if(this.history.length>this.maxHistory)this.history.shift();
    this.totalObserved++;
  }

  private empiricalWindowProb(digit:number,k:number):{prob:number;samples:number}{
    const uniformBaseline=1-Math.pow(0.9,k);
    const currentGap=this.totalObserved-(this.lastSeenTick.get(digit)??-1)-1;
    const gaps=this.gapsByDigit.get(digit)??[];
    const survived=gaps.filter(g=>g>currentGap);
    if(survived.length<5)return{prob:uniformBaseline,samples:survived.length};
    const hits=survived.filter(g=>g<=currentGap+k).length;
    const empirical=(hits+1)/(survived.length+2);
    const w=survived.length/(survived.length+30);
    return{prob:w*empirical+(1-w)*uniformBaseline,samples:survived.length};
  }

  rank(k:number,nextRanking:ReturnType<typeof scoreDigits>):HorizonDigitScore[]{
    const baseline=1-Math.pow(0.9,k);
    const rows:HorizonDigitScore[]=[];
    for(const row of nextRanking){
      const digit=row.digit;
      const {prob,samples}=this.empiricalWindowProb(digit,k);
      const currentGap=this.totalObserved-(this.lastSeenTick.get(digit)??-1)-1;
      const gaps=this.gapsByDigit.get(digit)??[];
      const meanGap=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:10;
      rows.push({
        digit,
        horizonProbability:prob,
        lift:baseline>0?prob/baseline:1,
        rawGapSamples:samples,
        gap:currentGap,
        gapExpectation:meanGap,
        overdueRatio:meanGap>0?currentGap/meanGap:1,
        nextTickScore:row.score??0,
        combined:0,
      });
    }
    const probs=rows.map(r=>r.horizonProbability);
    const nexts=rows.map(r=>r.nextTickScore);
    const pMin=Math.min(...probs),pMax=Math.max(...probs);
    const nMin=Math.min(...nexts),nMax=Math.max(...nexts);
    const pSpan=pMax-pMin||1, nSpan=nMax-nMin||1;
    for(const r of rows){
      const pNorm=(r.horizonProbability-pMin)/pSpan;
      const nNorm=(r.nextTickScore-nMin)/nSpan;
      r.combined=0.7*pNorm+0.3*nNorm;
    }
    rows.sort((a,b)=>b.combined-a.combined);
    return rows;
  }
}

export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,currency}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;currency?:string}){
  const {setTarget} = useExecutionTarget();
  const {publishForecast} = useEngineForecast();
  const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
  const [strategy,setStrategy]=useState<Strategy>('DYNAMIC');const [lockDuration,setLockDuration]=useState('999');
  const [horizonTicks,setHorizonTicks]=useState('5');
  const [minHorizonLift,setMinHorizonLift]=useState('1.0');
  const [minHorizonProbability,setMinHorizonProbability]=useState('0.50');
  const [minOverdueRatio,setMinOverdueRatio]=useState('1.0');
  const lockPurchases=useRef(new Map<number,number>());
  const lockRef=useRef<{digit:number;elapsed:number;source:EntryKind;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number};originSequence:number;originEpoch:number;gapAtLock:number;gapExpectation:number;horizonProb:number;horizonLift:number}|null>(null);
  const [lockPosition,setLockPosition]=useState(0);
  const [tradeLockView,setTradeLockView]=useState<{digit:number;source:EntryKind;elapsed:number}|null>(null);
  const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('0');const [minMomentum,setMinMomentum]=useState('0');
  const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
  const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
  const scoreHistoryRef=useRef<Record<number,number>[]>([]);
  const intelligenceRef=useRef(new NextTickIntelligence());
  const horizonAnalyzerRef=useRef(new DigitHorizonAnalyzer());
  const pendingHorizonRef=useRef<PendingHorizon[]>([]);
  const horizonResultsRef=useRef<number[]>([]);
  const [horizonAccuracy,setHorizonAccuracy]=useState({trials:0,hits:0,lower95:0,horizon:5,warmup:0});
  const [horizonRankingView,setHorizonRankingView]=useState<HorizonDigitScore[]>([]);
  const [entrySignal,setEntrySignal]=useState<EntryKind|null>(null);
  const [lastTrace,setLastTrace]=useState<{trace:FrozenEntryTrace;contractId:number;entryDigit:number|null;expiryDigit:number|null;profit:number;outcome:'WIN'|'LOSS';entryEpoch:number|null;expiryEpoch:number|null}|null>(null);
  const [entryTimingView,setEntryTimingView]=useState<string|null>(null);
  const executionForecastRef=useRef(new ExecutionAwareForecast());
  const [executionAudit,setExecutionAudit]=useState<ReturnType<ExecutionAwareForecast['audit']>|null>(null);
  const [horizonTarget,setHorizonTarget]=useState<number|null>(null);
  const [horizonProbability,setHorizonProbability]=useState<number|null>(null);
  const [intelligenceAudit,setIntelligenceAudit]=useState<ReturnType<NextTickIntelligence['getAudit']>|null>(null);
  const outstanding=useRef(new Map<number,{digit:number;stake:number;signalEpoch:number;purchaseEpoch:number|null;}>());
  const reservedStake=useRef(0);
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
  const uncertainPurchase=useRef(false);
  const matchHoldIds=useRef(new Set<number>());
  const [matchHoldCount,setMatchHoldCount]=useState(0);
  const [entryStatus,setEntryStatus]=useState('Waiting for signal');
  const [stopReason,setStopReason]=useState('Not started');
  const lastSignalDispatchMs=useRef<number|null>(null);
  const pendingMatchObserved=useRef(false);
  const winConfirmed=useRef(false);
  const verifiedWinContract=useRef<number|null>(null);
  const streamTicks=useRef<Array<{epoch:number;digit:number;quote:number;receivedAt:number}>>([]);
  const tickStats=useRef({received:0,outOfOrder:0,duplicates:0,staleQuotes:0});
  const tickSequence=useRef(0);
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

  const lastBuySignalSequence=useRef(0);
  const lastBuyAcknowledgedAtSequence=useRef(0);
  const seenTickKeys=useRef(new Set<string>());
  const seenTickOrder=useRef<string[]>([]);
  const tickCadence=useRef<{lastArrival:number|null;intervalMs:number|null}>({lastArrival:null,intervalMs:null});
  const [cadenceLabel,setCadenceLabel]=useState('Measuring tick interval');
  const [streamStatus,setStreamStatus]=useState('Tick stream warming up');
  const [outstandingCount,setOutstandingCount]=useState(0);
  const confirmedLosses=useRef(0);
  const [syncStatus,setSyncStatus]=useState('Waiting for a purchase');
  const [topMomentum,setTopMomentum]=useState<number|null>(null);
  const [targetMomentum,setTargetMomentum]=useState<number|null>(null);
  const [targetProbability,setTargetProbability]=useState<number|null>(null);
  const [targetScore,setTargetScore]=useState<number|null>(null);
  const [targetRises,setTargetRises]=useState<number|null>(null);
  const nextTickPending=useRef<number|null>(null);
  const eligibleResults=useRef<number[]>([]);
  const [accuracyAudit,setAccuracyAudit]=useState({trials:0,hits:0,lower95:0});
  const [requireEvidence,setRequireEvidence]=useState(false);
  const requireEvidenceRef=useRef(requireEvidence);requireEvidenceRef.current=requireEvidence;
  const wilsonLower=(hits:number,n:number)=>{
    if(!n)return 0;
    const z=1.96, p=hits/n, z2=z*z;
    return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n);
  };
  const evidenceReady=accuracyAudit.trials>=150 && accuracyAudit.lower95>0.1;
  const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
  const valid=Number.isInteger(Number(lockDuration))&&Number(lockDuration)>=1&&Number(lockDuration)<=9999&&Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0&&[1,3,4,5].includes(Number(horizonTicks))&&Number.isFinite(Number(minHorizonLift))&&Number(minHorizonLift)>=0&&Number.isFinite(Number(minHorizonProbability))&&Number(minHorizonProbability)>=0&&Number(minHorizonProbability)<=1&&Number.isFinite(Number(minOverdueRatio))&&Number(minOverdueRatio)>=0;
  const next=amount(Number(base)*Math.pow(Number(factor),countRef.current));const scopeKey=`${accountId}:${symbol}`;
  const [latency,setLatency]=useState<{quote:number;buy:number;settlement:number}|null>(null);
  const [dispatchTiming,setDispatchTiming]=useState<{signalToSubmitMs:number;acknowledgmentMs:number;ticksDuringAck:number}|null>(null);
  const signalTimingRef=useRef({signalToSubmitMs:0,acknowledgmentMs:0,ticksDuringAck:0});
  const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
  const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
  const setTargetRef=useRef(setTarget);setTargetRef.current=setTarget;
  const publishForecastRef=useRef(publishForecast);publishForecastRef.current=publishForecast;
  const stop=useCallback(()=>{setStopReason('Stopped manually or by risk-control request');halt.current=true;active.current=false;setTargetRef.current(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);setMode(m=>m==='RUNNING'?'STOPPED':m)},[]);
  const stopRef=useRef(stop);stopRef.current=stop;
  useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];intelligenceRef.current.reset();horizonAnalyzerRef.current.reset();pendingHorizonRef.current=[];horizonResultsRef.current=[];setHorizonAccuracy({trials:0,hits:0,lower95:0,horizon:Number(horizonTicks)||5,warmup:0});setHorizonRankingView([]);setEntryTimingView(null);setEntrySignal(null);setLastTrace(null);executionForecastRef.current.reset();setLastTiming(null);setExecutionAudit(null);setHorizonTarget(null);setHorizonProbability(null);setIntelligenceAudit(null);nextTickPending.current=null;eligibleResults.current=[];setAccuracyAudit({trials:0,hits:0,lower95:0});if(!unsettled)confirmedLosses.current=0;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setTopMomentum(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);lockedRef.current=null;if(!unsettled){countRef.current=0;setSentCount(0);lossBlockRef.current=0;pnlRef.current=0;}if(!unsettled){pending.current=false;pendingCount.current=0;inFlight.current.clear();matchPause.current=false;setMatchPaused(false);setInFlightCount(0);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';if(!unsettled)matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');setStopReason('Account or symbol changed');paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0};setPaceView({...paceRef.current});tickLedger.current.clear();setLedgerView([]);tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');setHistory([]);setScores([]);setLockedDigit(null);setTargetRef.current(null);setCount(0);setPnl(0);setLossBlock(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;verifiedWinContract.current=null;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv before restarting.');else setErr('')}},[scopeKey]);
  const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,firstLockMatch:boolean,entryKind:EntryKind,soonHorizon:number|null,frozenTrace:FrozenEntryTrace)=>{
   if(winConfirmed.current||verifiedWinContract.current!==null)return;
   if(entryKind!=='NEXT' || frozenTrace.signalKind!=='NEXT' || (entryStrategy==='MOMENTUM_LOCK' && frozenTrace.lockSource!=='NEXT'))return;
   if(!ws||!accountId||halt.current||!active.current||uncertainPurchase.current||countRef.current>=Number(limit))return;
   if(signalSequence<=lastBuySignalSequence.current){recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Duplicate dispatch prevented',predicted,frozenTrace.tradingLockOriginSequence);return;}
   if(inFlight.current.has(signalSequence)){recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Purchase already pending for tick',predicted,frozenTrace.tradingLockOriginSequence);return;}
   pendingCount.current++;
   pending.current=true;
   inFlight.current.set(signalSequence,{digit:predicted,stake});
   refreshExposure();
   let contractId:number|undefined;let purchaseAttempted=false;
   reservedStake.current=amount(reservedStake.current+stake);refreshExposure();
   try{
    if(!/^[A-Za-z0-9_]{2,30}$/.test(symbol))throw new Error('No valid trading symbol selected');
    if(tickSequence.current!==signalSequence || signalSequence<=lastBuySignalSequence.current || halt.current ){
      tickStats.current.staleQuotes++;
      recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Tick changed or cycle halted before send',predicted,frozenTrace.tradingLockOriginSequence);
      reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
      if(active.current&&!halt.current)setMode(outstanding.current.size?'SETTLING':'RUNNING');
      return;
    }
    if(tickSequence.current!==signalSequence){
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Newer tick arrived before send',predicted,frozenTrace.tradingLockOriginSequence);
     setEntryStatus('Newer tick arrived before dispatch · waiting for fresh signal');
     setMode('RUNNING');
     return;
    }
    const elapsedMs=performance.now()-signalReceivedAt;
    const freshnessBudgetMs=Math.max(1000,(tickCadence.current.intervalMs??1000)*1.5);
    if(elapsedMs>freshnessBudgetMs){
     tickStats.current.staleQuotes++;
     reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
     recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'SKIPPED','Signal exceeded freshness budget',predicted,frozenTrace.tradingLockOriginSequence);
     setEntryStatus('Signal expired before dispatch · awaiting fresh tick');
     setMode('RUNNING');
     return;
    }
    if(entryKind!=='NEXT' || frozenTrace.signalKind!=='NEXT'){
      reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
      recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED','Not the current NEXT forecast',predicted,frozenTrace.tradingLockOriginSequence);
      setEntryStatus('Rejected stale target');
      return;
    }
    const expectedTarget = entryStrategy==='MOMENTUM_LOCK'
      ? frozenTrace.tradingLockOriginDigit
      : frozenTrace.nextDigit;
    if(predicted !== expectedTarget){
      reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
      recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED','Target mismatch against frozen forecast',predicted,frozenTrace.tradingLockOriginSequence);
      setEntryStatus('Rejected stale target');
      return;
    }
    lastBuySignalSequence.current=signalSequence;
    purchaseAttempted=true;
    countRef.current++;
    setCount(countRef.current);
    setSentCount(countRef.current);
    const buyStart=performance.now();
    const signalToSubmitMs=Math.max(0,Math.round(buyStart-signalReceivedAt));
    const buyPromise=ws.send<any>({
      buy:'1', price:amount(stake*1.05),
      parameters:{amount:stake,basis:'stake',contract_type:'DIGITMATCH',
        currency:currency??'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,
        barrier:String(predicted)},
    });
    paceRef.current.eligible++;
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
    const purchaseEpoch=Number(bought?.buy?.start_time ?? bought?.buy?.purchase_time ?? bought?.buy?.transaction_time);
    const acknowledgedEpoch=Number.isFinite(purchaseEpoch)&&purchaseEpoch>0?purchaseEpoch:null;
    contractId=Number(bought?.buy?.contract_id);
    if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
    if(!Number.isFinite(ask)||ask<=0||ask>stake*1.05+0.001)throw new Error('Confirmed purchase price exceeds maximum; reconcile with Deriv');
    play('buy');
    reservedStake.current=amount(reservedStake.current-stake+ask);
    outstanding.current.set(contractId,{digit:predicted,stake:ask,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});
    recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'ACCEPTED','Deriv acknowledged contract',predicted,frozenTrace.tradingLockOriginSequence,contractId);
    paceRef.current.accepted++;queueMicrotask(publishPace);
    setSyncStatus(`Bought #${contractId} · target ${predicted} · signal ${tickEpoch} · ${acknowledgedEpoch===null?'purchase time unavailable':`buy ${acknowledgedEpoch}`}`);
    setOutstandingCount(outstanding.current.size);
    if(!matchPause.current && active.current && !halt.current && !winConfirmed.current && !uncertainPurchase.current)setMode('RUNNING');
    const id=contractId;    void (async()=>{
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
        if(c.is_sold || c.status==='won' || c.status==='lost'){
           const settledProfit=Number(c.profit);
           const sold=Number(c.sell_price??c.payout);
           const cost
