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
type LockMode='STRICT'|'EAGER';
type TickDecision={sequence:number;epoch:number;observedDigit:number;target:number|null;lockOriginSequence:number|null;status:'ELIGIBLE'|'SENT'|'ACCEPTED'|'SETTLED'|'SKIPPED'|'REJECTED'|'UNCERTAIN';reason:string;contractId:number|null;entryDigit?:number|null;entryEpoch?:number|null;expiryDigit?:number|null;expiryEpoch?:number|null;result?:'WIN'|'LOSS';at:string};
type FrozenEntryTrace={strategy:Strategy;lockSource:EntryKind|null;signalKind:EntryKind;target:number;nextDigit:number|null;signalSequence:number;signalEpoch:number;signalObservedDigit:number;signalReceivedAtIso:string;momentum:number;score:number;positiveSteps:number;forecastProbability:number|null;lockRemainingTicks:number|null;tradingLockOriginSequence:number|null;tradingLockOriginEpoch:number|null;tradingLockOriginDigit:number|null;
  horizonTicks?:number;horizonProbability?:number;horizonLift?:number;horizonRank?:number;horizonGapAtLock?:number;horizonGapExpectation?:number;survivalP?:number;shortHitRate?:number;shortHitRateLB?:number;gapRiskRatio?:number;
  dnaProbability?:number;dnaOutOfSampleLB?:number;dnaHasEdge?:boolean;dnaModelAge?:number;
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
const wilsonLower=(hits:number,n:number):number=>{
  if(!n)return 0;
  const z=1.96, p=hits/n, z2=z*z;
  return (p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n);
};
const sigmoid=(z:number)=>1/(1+Math.exp(-Math.max(-20,Math.min(20,z))));

// ════════════════════════════════════════════════════════════════════════════
// DigitDNAModel
// ─────────────────────────────────────────────────────────────────────────────
// Per-digit logistic classifier trained online with 5-fold walk-forward
// validation. Reports out-of-sample Wilson LB so the caller can decide
// whether an edge exists (STRICT) or just take the best pick (EAGER).
// ════════════════════════════════════════════════════════════════════════════
interface DNAFeature { gap:number; recentCount:number; recentMomentum:number; transitionProb:number; overdueRatio:number; }
interface DNAPrediction {
  digit:number;
  probability:number;         // σ(w·x+b) for this digit right now
  outOfSampleLB:number;       // Wilson LB of walk-forward out-of-sample hit rate
  outOfSampleHitRate:number;  // walk-forward out-of-sample hit rate (raw)
  outOfSampleSamples:number;  // total out-of-sample trials
  hasEdge:boolean;            // outOfSampleLB > baseline
  feature:GapFeature;
}
interface GapFeature extends DNAFeature {}
interface DNAWindow {
  // feature snapshot taken at tick t (BEFORE the label is known)
  features:[number,number,number,number,number];
  label:0|1;
  digit:number;
  frozenAtSeq:number;
}

const NUM_FEATURES=5;

class DigitDNAModel {
  private history:number[]=[];                       // full tick history of digits
  private windows:DNAWindow[]=[];                    // training windows: (features at t, did digit appear in t+1..t+k)
  private gapsByDigit=new Map<number,number[]>();
  private lastSeenTick=new Map<number,number>();
  private transitionCounts:number[][]=Array.from({length:10},()=>new Array(10).fill(0));
  private totalObserved=0;
  private k=3;                                       // horizon
  private readonly maxWindows=2000;                  // training buffer cap
  private readonly minTrainingSamples=200;           // don't train below this
  private readonly refitInterval=50;                 // refit every N new windows
  private ticksSinceRefit=0;
  // Per-digit weights: [bias, gap, recentCount, recentMomentum, transitionProb, overdueRatio]
  private weights:number[][]=Array.from({length:10},()=>new Array(NUM_FEATURES+1).fill(0));
  // Out-of-sample stats per digit
  private oosHits:number[]=new Array(10).fill(0);
  private oosTrials:number[]=new Array(10).fill(0);
  private lastOOS:Array<{hit:boolean;predictedProb:number}>[][]=Array.from({length:10},()=>[]);
  private pendingWindows:Array<{window:DNAWindow;expiresAtSeq:number;hit:boolean}>=[];

  reset(){this.history=[];this.windows=[];this.gapsByDigit.clear();this.lastSeenTick.clear();this.transitionCounts=Array.from({length:10},()=>new Array(10).fill(0));this.totalObserved=0;this.ticksSinceRefit=0;this.weights=Array.from({length:10},()=>new Array(NUM_FEATURES+1).fill(0));this.oosHits=new Array(10).fill(0);this.oosTrials=new Array(10).fill(0);this.pendingWindows=[];this.lastOOS=Array.from({length:10},()=>[])}

  setHorizon(k:number){if(k!==this.k){this.k=k;this.windows=[];this.pendingWindows=[];this.oosHits=new Array(10).fill(0);this.oosTrials=new Array(10).fill(0);}}

  private currentFeatures(digit:number):number[]{
    const gap=this.totalObserved-(this.lastSeenTick.get(digit)??-1)-1;
    const recent=this.history.slice(-20);
    const recentCount=recent.filter(d=>d===digit).length;
    const earlier=this.history.slice(-30,-10);
    const earlierCount=earlier.filter(d=>d===digit).length;
    const recentMomentum=recentCount-earlierCount;
    const gaps=this.gapsByDigit.get(digit)??[];
    const meanGap=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:10;
    const overdueRatio=meanGap>0?gap/meanGap:1;
    // Transition probability: P(next = digit | current observed digit)
    const currentDigit=this.history[this.history.length-1]??-1;
    let transitionProb=0.1;
    if(currentDigit>=0){
      const row=this.transitionCounts[currentDigit];
      const total=row.reduce((a,b)=>a+b,0);
      if(total>0)transitionProb=row[digit]/total;
    }
    // Normalize so each feature is on a comparable scale (0..~2)
    return [
      Math.log(1+gap)/Math.log(20),         // log-scaled gap
      recentCount/20,                        // recent frequency
      Math.max(-1,Math.min(1,recentMomentum/5)), // signed momentum
      transitionProb*10,                     // scaled transition
      Math.min(3,overdueRatio),
    ];
  }

  observe(digit:number):{
    predictions:DNAPrediction[];
    modelAge:number;
    oosOverallAccuracy:number;
  }{
    const t=this.totalObserved;
    // 1. Grade any pending windows whose horizon has now expired
    const stillPending:typeof this.pendingWindows=[];
    for(const p of this.pendingWindows){
      if(t>p.expiresAtSeq){
        // window is complete; its hit flag was already set during intermediate ticks
        this.windows.push(p.window);
        if(this.windows.length>this.maxWindows)this.windows.shift();
      } else {
        if(t>p.window.frozenAtSeq && t<=p.expiresAtSeq && digit===p.window.digit)p.hit=true;
        stillPending.push(p);
      }
    }
    this.pendingWindows=stillPending;

    // 2. Update gap stats + transition matrix BEFORE snapshotting new features
    const last=this.lastSeenTick.get(digit);
    if(last!==undefined){
      const arr=this.gapsByDigit.get(digit)??[];
      arr.push(t-last);
      if(arr.length>200)arr.shift();
      this.gapsByDigit.set(digit,arr);
    }
    const prevDigit=this.history[this.history.length-1];
    if(prevDigit!==undefined && prevDigit>=0 && prevDigit<10){
      this.transitionCounts[prevDigit][digit]++;
    }
    this.lastSeenTick.set(digit,t);
    this.history.push(digit);
    if(this.history.length>500)this.history.shift();
    this.totalObserved++;

    // 3. Snapshot a training window for each digit at this tick (label unknown yet)
    for(let d=0;d<10;d++){
      const feat=this.currentFeatures(d);
      this.pendingWindows.push({
        window:{features:feat as [number,number,number,number,number],label:0,digit:d,frozenAtSeq:this.totalObserved},
        expiresAtSeq:this.totalObserved+this.k,
        hit:false,
      });
    }

    // 4. Refit periodically via walk-forward when enough data
    this.ticksSinceRefit++;
    if(this.ticksSinceRefit>=this.refitInterval && this.windows.length>=this.minTrainingSamples){
      this.refitAll();
      this.ticksSinceRefit=0;
    }

    // 5. Predict current per-digit probabilities
    const predictions:DNAPrediction[]=[];let oosHitsAll=0,oosTrialsAll=0;
    for(let d=0;d<10;d++){
      const feat=this.currentFeatures(d);
      const w=this.weights[d];
      let z=w[0];
      for(let i=0;i<NUM_FEATURES;i++)z+=w[i+1]*feat[i];
      const probability=sigmoid(z);
      const oosN=this.oosTrials[d];
      const oosHits=this.oosHits[d];
      const oosRate=oosN>0?oosHits/oosN:0;
      const oosLB=wilsonLower(oosHits,oosN);
      const baseline=1-Math.pow(0.9,this.k);
      predictions.push({
        digit:d,
        probability,
        outOfSampleLB:oosLB,
        outOfSampleHitRate:oosRate,
        outOfSampleSamples:oosN,
        hasEdge:oosN>=100 && oosLB>baseline,
        feature:feat as unknown as DNAFeature,
      });
      oosHitsAll+=oosHits;oosTrialsAll+=oosN;
    }
    predictions.sort((a,b)=>b.probability-a.probability);
    return {
      predictions,
      modelAge:this.windows.length,
      oosOverallAccuracy:oosTrialsAll>0?oosHitsAll/oosTrialsAll:0,
    };
  }

  private refitAll(){
    // 5-fold walk-forward per digit. For each fold, train on earlier windows,
    // evaluate on the fold's windows, accumulate OOS hits/trials.
    const baseline=1-Math.pow(0.9,this.k);
    this.oosHits=new Array(10).fill(0);
    this.oosTrials=new Array(10).fill(0);
    for(let d=0;d<10;d++){
      const rows=this.windows.filter(w=>w.digit===d);
      if(rows.length<40)continue;
      const foldSize=Math.floor(rows.length/5);
      if(foldSize<8)continue;
      let oosHit=0,oosTotal=0;
      for(let fold=0;fold<5;fold++){
        const testStart=fold*foldSize;
        const testEnd=fold===4?rows.length:testStart+foldSize;
        const train=rows.slice(0,testStart).concat(rows.slice(testEnd));
        if(train.length<20)continue;
        const w=this.trainFold(train);
        for(let i=testStart;i<testEnd;i++){
          const r=rows[i];
          let z=w[0];
          for(let f=0;f<NUM_FEATURES;f++)z+=w[f+1]*r.features[f];
          const p=sigmoid(z);
          // Classify: predict positive if p>baseline
          const pred=p>baseline?1:0;
          if(pred===1){oosTotal++;if(r.label===1)oosHit++;}
          else{oosTotal++;if(r.label===1)oosHit+=0;}
        }
      }
      this.oosHits[d]=oosHit;
      this.oosTrials[d]=oosTotal;
      // Full-model weights = train on all windows
      this.weights[d]=this.trainFold(rows);
    }
  }

  private trainFold(rows:DNAWindow[]):number[]{
    const w=new Array(NUM_FEATURES+1).fill(0);
    const lr=0.05;
    const epochs=60;
    for(let ep=0;ep<epochs;ep++){
      for(const r of rows){
        let z=w[0];
        for(let f=0;f<NUM_FEATURES;f++)z+=w[f+1]*r.features[f];
        const p=sigmoid(z);
        const err=r.label-p;
        w[0]+=lr*err;
        for(let f=0;f<NUM_FEATURES;f++)w[f+1]+=lr*err*r.features[f];
      }
    }
    return w;
  }
}

export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,currency}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;currency?:string}){
  const {setTarget} = useExecutionTarget();
  const {publishForecast} = useEngineForecast();
  const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
  const [strategy,setStrategy]=useState<Strategy>('MOMENTUM_LOCK');const [lockDuration,setLockDuration]=useState('999');
  const [horizonTicks,setHorizonTicks]=useState('3');
  const [lockMode,setLockMode]=useState<LockMode>('EAGER');
  const [minHorizonLift,setMinHorizonLift]=useState('1.0');
  const [minHorizonProbability,setMinHorizonProbability]=useState('0.271');
  const [minOverdueRatio,setMinOverdueRatio]=useState('1.0');
  const [maxSurvivalP,setMaxSurvivalP]=useState('0.50');
  const [minShortHitLB,setMinShortHitLB]=useState('0.271');
  const [maxGapRiskRatio,setMaxGapRiskRatio]=useState('2.0');
  const lockPurchases=useRef(new Map<number,number>());
  const lockRef=useRef<{digit:number;elapsed:number;source:EntryKind;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number};originSequence:number;originEpoch:number;gapAtLock:number;gapExpectation:number;horizonProb:number;horizonLift:number}|null>(null);
  const [lockPosition,setLockPosition]=useState(0);
  const [tradeLockView,setTradeLockView]=useState<{digit:number;source:EntryKind;elapsed:number}|null>(null);
  const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('0');const [minMomentum,setMinMomentum]=useState('0');
  const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
  const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);const [lossBlock,setLossBlock]=useState(0);
  const scoreHistoryRef=useRef<Record<number,number>[]>([]);
  const intelligenceRef=useRef(new NextTickIntelligence());
  const dnaModelRef=useRef(new DigitDNAModel());
  const [dnaView,setDnaView]=useState<{modelAge:number;oosOverallAccuracy:number;predictions:DNAPrediction[]}>({modelAge:0,oosOverallAccuracy:0,predictions:[]});
  const pendingHorizonRef=useRef<PendingHorizon[]>([]);
  const horizonResultsRef=useRef<number[]>([]);
  const [horizonAccuracy,setHorizonAccuracy]=useState({trials:0,hits:0,lower95:0,horizon:3,warmup:0});
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
  const evidenceReady=accuracyAudit.trials>=150 && accuracyAudit.lower95>0.1;
  const active=useRef(false),pending=useRef(false),halt=useRef(false),countRef=useRef(0),lossBlockRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
  const valid=Number.isInteger(Number(lockDuration))&&Number(lockDuration)>=1&&Number(lockDuration)<=9999&&Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0&&[1,3,4,5].includes(Number(horizonTicks))&&Number.isFinite(Number(minHorizonLift))&&Number(minHorizonLift)>=0&&Number.isFinite(Number(minHorizonProbability))&&Number(minHorizonProbability)>=0&&Number(minHorizonProbability)<=1&&Number.isFinite(Number(minOverdueRatio))&&Number(minOverdueRatio)>=0&&Number.isFinite(Number(maxSurvivalP))&&Number(maxSurvivalP)>0&&Number(maxSurvivalP)<=1&&Number.isFinite(Number(minShortHitLB))&&Number(minShortHitLB)>=0&&Number(minShortHitLB)<=1&&Number.isFinite(Number(maxGapRiskRatio))&&Number(maxGapRiskRatio)>0;
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
  useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];scoreHistoryRef.current=[];intelligenceRef.current.reset();dnaModelRef.current.reset();dnaModelRef.current.setHorizon(Number(horizonTicks)||3);setDnaView({modelAge:0,oosOverallAccuracy:0,predictions:[]});pendingHorizonRef.current=[];horizonResultsRef.current=[];setHorizonAccuracy({trials:0,hits:0,lower95:0,horizon:Number(horizonTicks)||3,warmup:0});setHorizonRankingView([]);setEntryTimingView(null);setEntrySignal(null);setLastTrace(null);executionForecastRef.current.reset();setLastTiming(null);setExecutionAudit(null);setHorizonTarget(null);setHorizonProbability(null);setIntelligenceAudit(null);nextTickPending.current=null;eligibleResults.current=[];setAccuracyAudit({trials:0,hits:0,lower95:0});if(!unsettled)confirmedLosses.current=0;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setTopMomentum(null);setTargetMomentum(null);setTargetProbability(null);setTargetScore(null);setTargetRises(null);lockedRef.current=null;if(!unsettled){countRef.current=0;setSentCount(0);lossBlockRef.current=0;pnlRef.current=0;}if(!unsettled){pending.current=false;pendingCount.current=0;inFlight.current.clear();matchPause.current=false;setMatchPaused(false);setInFlightCount(0);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';if(!unsettled)matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');setStopReason('Account or symbol changed');paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0};setPaceView({...paceRef.current});tickLedger.current.clear();setLedgerView([]);tickSequence.current=0;lastBuySignalSequence.current=0;lastBuyAcknowledgedAtSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setStreamStatus('Tick stream reset');setHistory([]);setScores([]);setLockedDigit(null);setTargetRef.current(null);setCount(0);setPnl(0);setLossBlock(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;verifiedWinContract.current=null;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv before restarting.');else setErr('')}},[scopeKey]);
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
    const id=contractId;
    void (async()=>{
     let unsubscribe:(()=>Promise<void>)|undefined;
     const settlementStart=performance.now();
     try{
      const settle=await new Promise<any>((resolve,reject)=>{
       let done=false;let pollTimer:ReturnType<typeof setInterval>|undefined;
       const timeout=setTimeout(()=>finish(null,new Error(`Unconfirmed contract ${id}; reconciliation required`)),45000);
       function finish(c:any,error?:Error){if(done)return;done=true;clearTimeout(timeout);if(pollTimer)clearInterval(pollTimer);if(error)reject(error);else resolve(c);}
       const handle=(frame:Record<string,unknown>)=>{
        const c=(frame as any).proposal_open_contract;
        if(Number(c?.contract_id)!==id)return;
        if(c.is_sold || c.status==='won' || c.status==='lost'){
           const settledProfit=Number(c.profit);const sold=Number(c.sell_price??c.payout);const cost=Number(c.buy_price);
           const verifiedWin=c.status==='won' || ((c.is_sold || c.status==='won') && (Number.isFinite(settledProfit)?settledProfit>0:Number.isFinite(sold)&&Number.isFinite(cost)&&sold>cost));
           if(verifiedWin){verifiedWinContract.current=id;winConfirmed.current=true;halt.current=true;active.current=false;setStopReason(`Verified winning contract #${id}`);setEntryStatus(`WIN confirmed by Deriv on #${id} · no further purchases`);setMode('WIN');}
           finish(c);
         }
       };
       void ws.subscribe({proposal_open_contract:1,contract_id:id},handle).then(sub=>{unsubscribe=sub.unsubscribe;if(done)void sub.unsubscribe()}).catch(()=>{
         if(done)return;
         const poll=async()=>{try{handle(await ws.send<any>({proposal_open_contract:1,contract_id:id}))}catch{}};
         pollTimer=setInterval(()=>void poll(),1200);void poll();
       });
      });
      const payout=Number(settle.sell_price??settle.payout); const buyPrice=Number(settle.buy_price??ask);
      if(!Number.isFinite(payout)||!Number.isFinite(buyPrice)||payout<0||buyPrice<=0)throw new Error('Settlement amounts unavailable');
      setLatency(old=>old?{...old,settlement:Math.round(performance.now()-settlementStart)}:null);
      const profit=amount(payout-buyPrice);pnlRef.current=amount(pnlRef.current+profit);setPnl(pnlRef.current);
      const win=profit>0;executionForecastRef.current.observeSettlement(win);
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
      setLastTiming({contractId:id,target:predicted,signalSequence,ackTicks:ticksDuringAcknowledgment,submitMs:signalToSubmitMs,buyMs:Math.round(acknowledgedAt-buyStart),entryDigit,expiryDigit,result:win?'WIN':'LOSS'});
      const alignedTicks=expiryEpoch===null?[]:streamTicks.current.filter(t=>t.epoch===expiryEpoch);
      const aligned=alignedTicks.length===1?alignedTicks[0]:null;
      const observationResult=aligned?` · streamed expiry-epoch digit ${aligned.digit}${aligned.digit===expiryDigit?' (aligned)':' (disagrees: verify pip precision)'}`:` · ${alignedTicks.length>1?'multiple same-second ticks':'expiry tick not in browser buffer'} (no browser match inferred)`;
      setSyncStatus(`Contract #${id}: target ${predicted} · expiry ${expiryDigit??'unknown'} at ${expiryEpoch??'unknown'} · ${win?'WIN':'LOSS'} (Deriv verified)${observationResult}`);
      setLastOutcome(old=>old?.outcome==='WIN'&&!win?old:{id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS',expiryDigit,expiryEpoch,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});play(win?'win':'loss');
      const journalRow:MomentumTrade={frozenTrace,verifiedExpiryMatchesTarget:expiryDigit===null?null:expiryDigit===predicted,entryVsSignalSeconds:entryEpoch===null?null:entryEpoch-tickEpoch,expiryVsSignalSeconds:expiryEpoch===null?null:expiryEpoch-tickEpoch,entryKind,soonHorizon:undefined,entryDelayTicks:entryEpoch===null?null:Math.max(0,entryEpoch-tickEpoch),signalSequence,signalToSubmitMs,ticksDuringAcknowledgment,signalAgeBudgetMs:Math.max(1000,(tickCadence.current.intervalMs??1000)*1.5),buyAcknowledgmentMs:Math.round(acknowledgedAt-buyStart),entryEpoch,entryDigit,entrySpot:entrySpot===null?null:String(entrySpot),exitSpot:settle.exit_spot===undefined?null:String(settle.exit_spot),strategy:entryStrategy,lockTick,lockDuration:lockWindow,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch,expiryEpoch,expiryDigit,recordType:'TRADE',contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,momentumRising:signal.momentum3>0&&signal.positiveSteps>=2,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS'};
      try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:MomentumTrade)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
      if(matchPause.current)setEntryStatus('Matched tick observed · verifying all unsettled contracts');
      outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);refreshExposure();
      if(win){setStopReason('Verified winning contract');winConfirmed.current=true;halt.current=true;active.current=false;matchPause.current=false;setMatchPaused(false);lockedRef.current=null;lockRef.current=null;setLockedDigit(null);setLockPosition(0);setTradeLockView(null);setTargetRef.current(null);setTargetScore(null);setTargetMomentum(null);setTargetProbability(null);setTargetRises(null);setMode('WIN')}
      else{confirmedLosses.current++;if(winConfirmed.current){setMode('WIN')}else if(countRef.current>=Number(limit)){setStopReason('Maximum purchases reached');halt.current=true;active.current=false;setMode('MAX_TRADES')}else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){setStopReason('Cycle loss/exposure limit reached');halt.current=true;active.current=false;setMode('MAX_LOSS')}else if(active.current&&!halt.current&&!matchPause.current&&!uncertainPurchase.current){setMode('RUNNING');setEntryStatus('Settled · next eligible tick may submit a buy');}}
      releaseMatchPause();
     }catch(e){setStopReason('Settlement could not be verified');halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv before restarting.`)}
     finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size);releaseMatchPause()}
    })();
   }catch(e){
    setStopReason('Purchase request failed or is uncertain');halt.current=true;active.current=false;
    if(purchaseAttempted){const msg=String(e);const isBalance=/balance|insufficient|not enough|not_enough/i.test(msg);
      if(isBalance){uncertainPurchase.current=false;reservedStake.current=Math.max(0,amount(reservedStake.current-stake));recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED',msg,predicted,frozenTrace.tradingLockOriginSequence);setMode('STOPPED');setErr('Insufficient balance — cycle stopped, no contract was opened.');}
      else{recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'UNCERTAIN',msg,predicted,frozenTrace.tradingLockOriginSequence,contractId??null);uncertainPurchase.current=true;setMode('UNCERTAIN');setErr(`Purchase status unknown: ${msg}. Reconcile in Deriv.`);}
    }else{recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED',String(e),predicted,frozenTrace.tradingLockOriginSequence);reservedStake.current=Math.max(0,amount(reservedStake.current-stake));setMode('STOPPED');setErr(`No trade was purchased: ${String(e)}`);}
   }finally{inFlight.current.delete(signalSequence);pendingCount.current=Math.max(0,pendingCount.current-1);pending.current=pendingCount.current>0;refreshExposure();releaseMatchPause();}
  },[ws,accountId,symbol,limit,maxLoss,play,pipSize,currency]);
  const execRef=useRef(execute);execRef.current=execute;
  useEffect(()=>{if(!isConnected && active.current){setStopReason('WebSocket disconnected');halt.current=true;active.current=false;setMode('UNCERTAIN');setErr('Connection lost. Verify outstanding contracts on Deriv before a new cycle.');}},[isConnected]);
  const tickSettings=useRef({pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizonTicks,minHorizonLift,minHorizonProbability,minOverdueRatio,maxSurvivalP,minShortHitLB,maxGapRiskRatio,lockMode});
  tickSettings.current={pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizonTicks,minHorizonLift,minHorizonProbability,minOverdueRatio,maxSurvivalP,minShortHitLB,maxGapRiskRatio,lockMode};
  const processMarketTick=useCallback((tick:any)=>{
    const settings=tickSettings.current;
    if(tick.symbol && tick.symbol!==settings.symbol)return;
    if(!settings.symbol || !Number.isFinite(Number(tick.quote)))return;
    const epoch=Number(tick.epoch);
    if(!Number.isFinite(epoch))return;
    const key=`${epoch}:${Number(tick.quote)}`;
    if(seenTickKeys.current.has(key)){tickStats.current.duplicates++;return}
    const prevEpoch=Number(lastTickKey.current.split(':')[0]);
    if(lastTickKey.current && Number.isFinite(prevEpoch) && epoch<prevEpoch){tickStats.current.outOfOrder++;return;}
    if(epoch*1000<Date.now()-15000 || epoch*1000>Date.now()+15000){tickStats.current.staleQuotes++;setStreamStatus(`Tick rejected: timestamp ${Math.round((Date.now()-epoch*1000)/1000)}s from local clock · check clock/socket`);return;}
    lastTickKey.current=key;seenTickKeys.current.add(key);seenTickOrder.current.push(key);
    if(seenTickOrder.current.length>256){const expired=seenTickOrder.current.shift();if(expired)seenTickKeys.current.delete(expired);}
    const digit=getLastDigit(Number(tick.quote),Number.isInteger(tick.pip_size)?tick.pip_size:settings.pipSize);
    const receivedAt=performance.now();
    const previousArrival=tickCadence.current.lastArrival;
    if(previousArrival!==null){const interval=receivedAt-previousArrival;if(interval>0&&interval<15000){const prev=tickCadence.current.intervalMs;tickCadence.current.intervalMs=prev===null?interval:(prev*0.75+interval*0.25);}}
    tickCadence.current.lastArrival=receivedAt;
    const sequence=++tickSequence.current;
    recordTick(sequence,epoch,digit,'SKIPPED','Processing tick');
    streamTicks.current=[...streamTicks.current.slice(-99),{epoch,digit,quote:Number(tick.quote),receivedAt}];
    tickStats.current.received++;
    if(tickStats.current.received%5===0){const ms=tickCadence.current.intervalMs;setCadenceLabel(ms===null?'Measuring tick interval':`${(ms/1000).toFixed(2)}s/tick · ${(1000/ms).toFixed(2)} ticks/s`);setStreamStatus(`Stream ${tickStats.current.received} ticks · duplicates ${tickStats.current.duplicates} · out of order ${tickStats.current.outOfOrder} · stale quotes ${tickStats.current.staleQuotes}`);}
    if(nextTickPending.current!==null){const hit=Number(digit===nextTickPending.current);eligibleResults.current=[...eligibleResults.current.slice(-499),hit];const n=eligibleResults.current.length;const hits=eligibleResults.current.reduce((a,b)=>a+b,0);setAccuracyAudit({trials:n,hits,lower95:wilsonLower(hits,n)});}
    nextTickPending.current=null;
    const horizonK=Number(settings.horizonTicks)||3;
    const stillPending:PendingHorizon[]=[];
    for(const p of pendingHorizonRef.current){
      if(sequence>p.expiresAtSeq){horizonResultsRef.current.push(p.hit?1:0);if(horizonResultsRef.current.length>1000)horizonResultsRef.current.shift();}
      else{if(sequence>p.frozenAtSeq && sequence<=p.expiresAtSeq && digit===p.topDigit)p.hit=true;stillPending.push(p);}
    }
    pendingHorizonRef.current=stillPending;
    histRef.current=[...histRef.current.slice(-99),digit];
    const ranking=intelligenceRef.current.observe(digit);scoreRef.current=ranking;
    const dnaResult=dnaModelRef.current.observe(digit);
    const horizonRanking=horizonAnalyzerRef.current.rank(horizonK, ranking);
    const topHorizon=horizonRanking[0];
    if(topHorizon){pendingHorizonRef.current.push({frozenAtSeq:sequence,topDigit:topHorizon.digit,expiresAtSeq:sequence+horizonK,hit:false});}
    const telemetryScope=scope.current;
    queueMicrotask(()=>{
      if(scope.current!==telemetryScope)return;
      executionForecastRef.current.observe(digit);
      const research=executionForecastRef.current.forecast(ranking);
      const execTop=research?.ranked?.[0]??null;
      setHorizonTarget(execTop?.digit??null);
      setHorizonProbability(execTop?.executionProbability??null);
      setDnaView(dnaResult);
      if(sequence%5===0){setExecutionAudit(executionForecastRef.current.audit());setIntelligenceAudit(intelligenceRef.current.getAudit());const hr=horizonResultsRef.current;const trials=hr.length;const hits=trials?hr.reduce((a,b)=>a+b,0):0;setHorizonAccuracy({trials,hits,lower95:wilsonLower(hits,trials),horizon:horizonK,warmup:horizonAnalyzerRef.current.minGapSamples()});setHorizonRankingView(horizonRanking.slice(0,5));}
    });
    const top=ranking[0];const momentum=top?.momentum3 ?? null;
    const qualified=ranking.filter(row=>Number.isFinite(row.score) && row.score>=Number(settings.threshold) && row.momentum3>=Number(settings.minMomentum));
    const auditCandidate=top;
    if(auditCandidate && auditCandidate.score>=Number(settings.threshold) && auditCandidate.momentum3>=Number(settings.minMomentum)){nextTickPending.current=auditCandidate.digit;}
    const snapHist=histRef.current;
    queueMicrotask(()=>{if(scope.current!==telemetryScope)return;setHistory(snapHist);setScores(ranking);setTopMomentum(momentum);});
    let selected=lockRef.current;
    if(settings.strategy==='MOMENTUM_LOCK' && selected){selected={...selected,elapsed:selected.elapsed+1};if(selected.elapsed>Number(settings.lockDuration)){selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);}else{lockRef.current=selected;setLockPosition(selected.elapsed);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:selected.elapsed});}}
    else if(settings.strategy!=='MOMENTUM_LOCK' && selected){lockRef.current=null;selected=null;setLockPosition(0);setTradeLockView(null);}
    const displayTarget=settings.strategy==='MOMENTUM_LOCK' ? selected?.digit ?? top?.digit ?? null : top?.digit ?? null;
    const displayForecast=ranking.find(row=>row.digit===displayTarget);
    queueMicrotask(()=>{if(scope.current!==telemetryScope)return;setTargetMomentum(displayForecast?.momentum3??null);setTargetProbability(displayForecast?.probability??null);setTargetScore(displayForecast?.score??null);setTargetRises(displayForecast?.positiveSteps??null);});
    queueMicrotask(()=>{if(scope.current!==telemetryScope)return;publishForecastRef.current({symbol:settings.symbol,sequence,rows:ranking.map(row=>({digit:row.digit,score:row.score,probability:row.probability,momentum3:row.momentum3,positiveSteps:row.positiveSteps})),lockedDigit:settings.strategy==='MOMENTUM_LOCK' ? lockRef.current?.digit??null : null});});
    if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected){recordTick(sequence,epoch,digit,'SKIPPED',!active.current?'Cycle inactive':halt.current?'Cycle halted':uncertainPurchase.current?'Uncertain purchase':!settings.accountId?'No account':'Disconnected',lockRef.current?.digit??null,lockRef.current?.originSequence??null);return;}
    if(matchPause.current){recordTick(sequence,epoch,digit,'SKIPPED','Match pause active · awaiting settlement',lockRef.current?.digit??null,lockRef.current?.originSequence??null);return;}
    const activeTarget = settings.strategy==='MOMENTUM_LOCK' ? (lockRef.current?.digit ?? null) : (lockedRef.current ?? null);
    if(activeTarget !== null && digit===activeTarget){const originSeq = lockRef.current?.originSequence ?? null;if(outstanding.current.size>0 || pendingCount.current>0){matchPause.current=true;setMatchPaused(true);setMode('SETTLING');setEntryStatus(`${settings.strategy==='MOMENTUM_LOCK'?'Locked':'Last-target'} digit ${activeTarget} matched observed tick ${sequence} · pausing new trades until settlement`);recordTick(sequence,epoch,digit,'SKIPPED',`Target digit ${activeTarget} matched observed tick · pausing new trades until settlement`,activeTarget,originSeq);}else{recordTick(sequence,epoch,digit,'SKIPPED',`Target digit ${activeTarget} matched observed tick · skipping this tick`,activeTarget,originSeq);}return;}
    if(!ranking.length){skipPace('Forecast warming up');setEntryStatus('V1 warming up');return}
    if(countRef.current>=Number(settings.limit)){skipPace('Max trades reached');halt.current=true;active.current=false;setMode('MAX_TRADES');setStopReason('Maximum purchases reached');setEntryStatus('Max trades reached');return}
    const minLift=Number(settings.minHorizonLift);const minHorizonProb=Number(settings.minHorizonProbability);const minOverdue=Number(settings.minOverdueRatio);const maxSurvival=Number(settings.maxSurvivalP);const minHitLB=Number(settings.minShortHitLB);const maxGapRisk=Number(settings.maxGapRiskRatio);
    // ─── DNA + HORIZON CANDIDATE SELECTION ───────────────────────────────────
    // Candidate set: digits whose short-tail stats pass the user gates (survival,
    // gap risk, empirical 3-tick hit rate LB). Among those, the DNA model picks
    // the highest predicted probability.
    // In STRICT mode we additionally require the DNA OOS LB > baseline.
    // In EAGER mode we always take the top DNA pick from the survivor set.
    const baseline=1-Math.pow(0.9,horizonK);
    const dnaByDigit=new Map<number,DNAPrediction>();for(const p of dnaResult.predictions)dnaByDigit.set(p.digit,p);
    const survivors=horizonRanking
      .filter(r => r.survivalP >= maxSurvival)
      .filter(r => r.gapRiskRatio <= maxGapRisk)
      .filter(r => r.shortHitRateLB >= minHitLB)
      .filter(r => qualified.some(q => q.digit===r.digit))
      .filter(r => r.lift >= minLift)
      .filter(r => r.horizonProbability >= minHorizonProb)
      .filter(r => r.overdueRatio >= minOverdue)
      .filter(r => r.gap >= 1);
    // Rank survivors by DNA probability (highest first)
    survivors.sort((a,b)=>{
      const da=dnaByDigit.get(a.digit)?.probability??0;
      const db=dnaByDigit.get(b.digit)?.probability??0;
      if(Math.abs(db-da)>0.005)return db-da;
      return b.horizonProbability-a.horizonProbability;
    });
    const survivorChoice=survivors[0]??null;
    // STRICT mode filter: only survivors whose DNA OOS LB > baseline
    const strictChoices=survivors.filter(r=>{const d=dnaByDigit.get(r.digit);return d!==undefined && d.hasEdge;});
    const horizonChoice = settings.lockMode==='STRICT' ? (strictChoices[0]??null) : survivorChoice;
    const nextCandidate = top && qualified.some(row=>row.digit===top.digit) ? top : null;
    const choiceForecast = horizonChoice ? (qualified.find(q => q.digit===horizonChoice.digit) ?? null) : nextCandidate;
    const choiceKind:EntryKind='NEXT';
    if(selected?.source!=='NEXT' && selected){selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);}
    if(settings.strategy==='MOMENTUM_LOCK' && !selected && choiceForecast && horizonChoice){
      selected={digit:choiceForecast.digit,elapsed:1,source:choiceKind,originSequence:sequence,originEpoch:epoch,signal:{score:choiceForecast.score,momentum3:choiceForecast.momentum3,positiveSteps:choiceForecast.positiveSteps,threshold:Number(settings.threshold)},gapAtLock:horizonChoice.gap,gapExpectation:horizonChoice.gapExpectation,horizonProb:horizonChoice.horizonProbability,horizonLift:horizonChoice.lift};
      lockRef.current=selected;setLockPosition(1);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:1});
    }
    if(!choiceForecast && !(settings.strategy==='MOMENTUM_LOCK' && selected)){
      const topLift=horizonRanking[0]?.lift??0;const topProb=horizonRanking[0]?.horizonProbability??0;const topSurv=horizonRanking[0]?.survivalP??0;
      const reason=settings.lockMode==='STRICT'?'No digit passes STRICT DNA edge + tail gates':'No digit passes short-tail gates';
      skipPace(`${reason} · best P=${(100*topProb).toFixed(1)}% surv=${(100*topSurv).toFixed(1)}% lift ${topLift.toFixed(2)}×`);
      setEntryStatus(`${reason} · waiting for DNA edge on a short-tail digit`);
      return;
    }
    if(settings.strategy==='MOMENTUM_LOCK' && !selected){
      const bestP=horizonRanking[0]?.horizonProbability??0;const bestLift=horizonRanking[0]?.lift??0;
      skipPace(`Lock not yet acquired · best P(k)=${(100*bestP).toFixed(1)}% lift=${bestLift.toFixed(2)}×`);
      setEntryStatus('Waiting for due digit to acquire lock');return;
    }
    if(requireEvidenceRef.current && (eligibleResults.current.length<150 || wilsonLower(eligibleResults.current.reduce((a,b)=>a+b,0),eligibleResults.current.length)<=0.1)){skipPace('Evidence gate');setEntryStatus(`V1 evidence gate: ${eligibleResults.current.length}/150; lower bound must exceed 10%`);return;}
    const target=settings.strategy==='MOMENTUM_LOCK' ? selected!.digit : choiceForecast!.digit;
    const chosenForecast=ranking.find(row=>row.digit===target);
    const chosenHorizon=horizonRanking.find(row=>row.digit===target) ?? null;
    const chosenDNA=dnaByDigit.get(target) ?? null;
    if(!chosenForecast){skipPace('Target unavailable');setEntryStatus('V1 target unavailable');return;}
    const ownMomentum=chosenForecast.momentum3;const ownRises=chosenForecast.positiveSteps;const ownRising=ownMomentum>=Number(settings.minMomentum);
    if(settings.strategy==='DYNAMIC' && (chosenForecast.score<Number(settings.threshold) || !ownRising)){skipPace('Score or rising momentum gate');setEntryStatus(`Dynamic NEXT ${target}: score ${chosenForecast.score.toFixed(2)}/${settings.threshold} · momentum ${ownMomentum.toFixed(2)}/${settings.minMomentum} · rises ${ownRises}/3`);return;}
    const signal={score:chosenForecast.score,momentum3:ownMomentum,positiveSteps:ownRises,threshold:Number(settings.threshold)};
    const signalKind:EntryKind='NEXT';
    const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
    const firstLockMatch=false;
    if(sequence<=lastBuySignalSequence.current){return;}
    const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
    if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){skipPace('Next stake would exceed loss limit');stopRef.current();setMode('MAX_LOSS');return;}
    lastSignalDispatchMs.current=receivedAt;lockedRef.current=target;
    queueMicrotask(()=>setEntrySignal(signalKind));
    const frozenTrace:FrozenEntryTrace={strategy:settings.strategy,lockSource:settings.strategy==='MOMENTUM_LOCK'?selected!.source:null,signalKind,target,nextDigit:top?.digit??null,signalSequence:sequence,signalEpoch:epoch,signalObservedDigit:digit,signalReceivedAtIso:new Date().toISOString(),momentum:ownMomentum,score:chosenForecast.score,positiveSteps:ownRises,forecastProbability:Number.isFinite(chosenForecast.probability)?chosenForecast.probability:null,lockRemainingTicks:null,tradingLockOriginSequence:settings.strategy==='MOMENTUM_LOCK'?selected?.originSequence??null:null,tradingLockOriginEpoch:settings.strategy==='MOMENTUM_LOCK'?selected?.originEpoch??null:null,tradingLockOriginDigit:settings.strategy==='MOMENTUM_LOCK'?selected?.digit??null:null,horizonTicks:chosenHorizon?horizonK:undefined,horizonProbability:chosenHorizon?chosenHorizon.horizonProbability:undefined,horizonLift:chosenHorizon?chosenHorizon.lift:undefined,horizonRank:chosenHorizon?horizonRanking.findIndex(r=>r.digit===target)+1:undefined,horizonGapAtLock:chosenHorizon?chosenHorizon.gap:undefined,horizonGapExpectation:chosenHorizon?chosenHorizon.gapExpectation:undefined,survivalP:chosenHorizon?chosenHorizon.survivalP:undefined,shortHitRate:chosenHorizon?chosenHorizon.shortHitRate:undefined,shortHitRateLB:chosenHorizon?chosenHorizon.shortHitRateLB:undefined,gapRiskRatio:chosenHorizon?chosenHorizon.gapRiskRatio:undefined,dnaProbability:chosenDNA?chosenDNA.probability:undefined,dnaOutOfSampleLB:chosenDNA?chosenDNA.outOfSampleLB:undefined,dnaHasEdge:chosenDNA?chosenDNA.hasEdge:undefined,dnaModelAge:dnaResult.modelAge};
    recordTick(sequence,epoch,digit,'ELIGIBLE',settings.strategy==='MOMENTUM_LOCK'?'Active NEXT-origin lock; new market tick':'Fresh qualified NEXT forecast',target,selected?.originSequence??null);
    queueMicrotask(publishPace);
    const previousCount=countRef.current;
    void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,settings.strategy==='MOMENTUM_LOCK'?Number(settings.lockDuration):0,firstLockMatch,signalKind,null,frozenTrace);
    if(settings.strategy==='MOMENTUM_LOCK' && selected && countRef.current>previousCount)lockPurchases.current.set(selected.originSequence,(lockPurchases.current.get(selected.originSequence)??0)+1);
    queueMicrotask(()=>{if(scope.current!==telemetryScope || !active.current || halt.current)return;setLockedDigit(target);setTargetRef.current(target);setEntryStatus(`${signalKind} sent on tick ${sequence} · ${pendingCount.current} ACK pending / ${outstanding.current.size} settling`);});
  },[]);

  const processMarketTickRef=useRef(processMarketTick);processMarketTickRef.current=processMarketTick;
  useEffect(()=>{if(!ws)return;return ws.onMessage((frame:Record<string,unknown>)=>{if(frame.msg_type==='tick' && frame.tick)processMarketTickRef.current(frame.tick);});},[ws]);
  useEffect(()=>{if(!isConnected || !currentTick || !symbol)return;processMarketTick({...currentTick,symbol});},[currentTick,symbol,isConnected,processMarketTick]);

  function start(){
   if(!valid||!accountId||!isConnected||!ws||pendingCount.current>0||active.current||uncertainPurchase.current||outstanding.current.size)return;
   const acc=real?'REAL MONEY':'DEMO';
   if(real&&!window.confirm(`REAL MONEY: Automated DigitMatch on ${symbol}. Up to ${limit} purchases, progression ${factor}×, max cycle loss $${maxLoss}. Confirm you accept this risk.`))return;
   if(!window.confirm(`Start ${acc} automatic cycle? Contract: 1-tick DigitMatch, one submission per eligible tick, overlapping contracts possible. Maximum loss: $${maxLoss}; up to ${limit} purchases. No guaranteed returns.`))return;
   if(mode==='UNCERTAIN'||uncertainPurchase.current||pendingCount.current>0||outstanding.current.size>0)return;
   paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—',lastDispatchSequence:0};
   setPaceView({...paceRef.current});tickLedger.current.clear();setLedgerView([]);
   lockPurchases.current.clear();matchHoldIds.current.clear();pendingMatchObserved.current=false;setMatchHoldCount(0);setEntryStatus('Waiting for signal');setStopReason('Running');countRef.current=0;setSentCount(0);pnlRef.current=0;reservedStake.current=0;setRiskExposure(0);matchPause.current=false;setMatchPaused(false);confirmedLosses.current=0;lossBlockRef.current=0;lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setCount(0);setPnl(0);setLossBlock(0);setLockedDigit(null);setTargetRef.current(null);setLastOutcome(null);setTargetScore(null);setTargetRises(null);setTargetMomentum(null);setTargetProbability(null);winConfirmed.current=false;verifiedWinContract.current=null;setErr('');halt.current=false;active.current=true;setLastTiming(null);setMode('RUNNING');if(sound)tone('buy');
  }
  return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
   <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars · DNA-Enhanced Tick Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
   <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
     <label className="flex items-center gap-2">Strategy
       <select value={strategy} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>{const v=e.target.value as Strategy;setStrategy(v);lockRef.current=null;setLockPosition(0);}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white"><option value="DYNAMIC">Dynamic V1</option><option value="MOMENTUM_LOCK">Momentum Lock</option></select>
     </label>
     <label className="flex items-center gap-2">Horizon k
       <select value={horizonTicks} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>{setHorizonTicks(e.target.value);dnaModelRef.current.setHorizon(Number(e.target.value)||3);}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white"><option value="1">1</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select>
     </label>
     <label className="flex items-center gap-2">Lock mode
       <select value={lockMode} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setLockMode(e.target.value as LockMode)} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white"><option value="EAGER">EAGER (trade every tick)</option><option value="STRICT">STRICT (only proven edge)</option></select>
     </label>
     {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Lock ticks <input type="number" min="1" max="9999" step="1" value={lockDuration} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setLockDuration(e.target.value)} className="w-16 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white" /></label>}
   </div>
   <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
   <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
     <label className="text-[11px] text-slate-300">Min P(k) <input type="number" min="0" max="1" step="0.01" value={minHorizonProbability} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinHorizonProbability(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Min overdue <input type="number" min="0" step="0.05" value={minOverdueRatio} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinOverdueRatio(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Min lift <input type="number" min="0" step="0.05" value={minHorizonLift} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinHorizonLift(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Max survival P <input type="number" min="0.01" max="1" step="0.01" value={maxSurvivalP} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMaxSurvivalP(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Max gap risk <input type="number" min="0.1" step="0.1" value={maxGapRiskRatio} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMaxGapRiskRatio(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
   </div>
   {strategy==='MOMENTUM_LOCK'&&<div className="mt-2 rounded-lg border border-emerald-500/30 bg-[#0a1721] p-2 text-xs">
     <div className="mb-1 flex items-center gap-3"><strong className="text-emerald-300">Momentum Lock · {lockMode} mode</strong>{lockMode==='EAGER'&&<span className="rounded bg-amber-900/50 px-2 py-0.5 text-[10px] font-bold text-amber-200">EAGER trades every tick · DNA edge shown per trade</span>}</div>
     <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-200">
       <span>Active target <strong className="text-white">{tradeLockView?.digit??'—'}</strong></span>
       <span>Remaining <strong>{tradeLockView?Math.max(0,Math.max(1,Number(lockDuration)||1)-tradeLockView.elapsed+1):'—'}</strong> ticks</span>
       <span>Purchases <strong>{lockRef.current?(lockPurchases.current.get(lockRef.current.originSequence)??0):0}</strong></span>
       <span>Status <strong className={mode==='RUNNING'&&!matchPaused&&!winConfirmed.current?'text-emerald-300':'text-amber-300'}>{mode==='UNCERTAIN'?'RECONCILIATION':winConfirmed.current||mode==='WIN'?'WIN · STOPPED':matchPaused?'MATCH HOLD':mode!=='RUNNING'?'NOT TRADING':!tradeLockView?'WAITING':lockMode==='EAGER'?'ACTIVE (EAGER)':'ACTIVE (STRICT)'}</strong></span>
     </div>
     <div className="mt-1 text-slate-400">{mode==='RUNNING'?`Latest: ${entryStatus}`:`Stop: ${stopReason}`}</div>
   </div>}
   {dnaView.predictions.length>0&&<div className="mt-2 rounded-md border border-fuchsia-500/30 bg-[#160d24] px-2 py-1.5 text-[11px]" aria-label="DNA model diagnostic">
     <div className="flex flex-wrap items-baseline gap-x-3"><span className="font-semibold text-fuchsia-300">DigitDNA model</span><span className="text-slate-400">windows={dnaView.modelAge} · OOS accuracy {(100*dnaView.oosOverallAccuracy).toFixed(1)}% · baseline {(100*(1-Math.pow(0.9,horizonAccuracy.horizon))).toFixed(1)}%</span></div>
     <div className="mt-1 font-mono text-[10px]">
       {dnaView.predictions.slice(0,5).map(p=>{const hasEdge=p.hasEdge;const lbPass=p.outOfSampleLB>=(1-Math.pow(0.9,horizonAccuracy.horizon));return <div key={p.digit} className="border-t border-slate-700/40 py-0.5"><span className="font-bold text-white">{p.digit}</span>{' · p='}{(100*p.probability).toFixed(1)}{'% · OOS LB '}<span className={lbPass?'text-emerald-400':'text-rose-400'}>{(100*p.outOfSampleLB).toFixed(1)}{'%'}</span>{' (n='}{p.outOfSampleSamples}{')'}{hasEdge?<span className="ml-2 rounded bg-emerald-900 px-1 text-emerald-200">EDGE</span>:<span className="ml-2 rounded bg-slate-800 px-1 text-slate-400">no edge</span>}</div>;})}
     </div>
     <div className="text-slate-500">OOS LB = Wilson 95% lower bound of walk-forward out-of-sample hit rate. EAGER mode still trades the top-pick, but this number tells you whether that pick had proven edge (EDGE badge) or not.</div>
   </div>}
   {horizonRankingView.length>0&&<div className="mt-2 rounded-md border border-violet-500/30 bg-[#0d1524] px-2 py-1.5 text-[11px]" aria-label="Horizon diagnostic">
     <div className="font-semibold text-violet-300">Due digit diagnostic · k={horizonAccuracy.horizon} · short-tail gates</div>
     <div className="text-slate-400">survival≥{(100*Number(maxSurvivalP)).toFixed(0)}% · gapRisk≤{Number(maxGapRiskRatio).toFixed(1)} · shortLB≥{(100*Number(minShortHitLB)).toFixed(1)}%</div>
     <div className="mt-1 font-mono text-[10px]">
       {horizonRankingView.map(r=>{const survPass=r.survivalP>=Number(maxSurvivalP);const riskPass=r.gapRiskRatio<=Number(maxGapRiskRatio);const lbPass=r.shortHitRateLB>=Number(minShortHitLB);return <div key={r.digit} className="border-t border-slate-700/40 py-0.5"><span className="font-bold text-white">{r.digit}</span>{' · gap '}{r.gap}{' · P3 '}<span className={lbPass?'text-emerald-400':'text-rose-400'}>{(100*r.shortHitRate).toFixed(1)}%</span>{' · LB '}{(100*r.shortHitRateLB).toFixed(1)}{'% · gapRisk '}<span className={riskPass?'text-emerald-400':'text-rose-400'}>{r.gapRiskRatio.toFixed(1)}{'×'}</span>{' · surv '}<span className={survPass?'text-emerald-400':'text-rose-400'}>{(100*r.survivalP).toFixed(0)}{'%'}</span></div>;})}
     </div>
   </div>}
   <div className="mt-2 rounded-md border border-cyan-500/30 bg-[#091725] px-2 py-1.5 text-[11px] text-slate-200">
     <span className="font-semibold text-cyan-300">Dispatch</span>
     <span className="ml-2">Sent <strong>{paceView.dispatched}</strong></span>
     <span className="ml-2">Accepted <strong>{paceView.accepted}</strong></span>
     <span className="ml-2">Skipped <strong>{paceView.skipped}</strong></span>
     <div className="text-slate-400">Last skipped: {paceView.lastSkip} · Last dispatched tick #{paceView.lastDispatchSequence||'—'} · {cadenceLabel}</div>
     <div className="mt-1 font-semibold text-cyan-300">Ledger</div>
     <div className="max-h-60 overflow-y-auto font-mono text-[10px]">{ledgerView.map(t=><div key={t.sequence} className="border-t border-slate-700/40 py-0.5">#{t.sequence} · mkt {t.observedDigit} · tgt {t.target??'—'} · <strong className={t.status==='ACCEPTED'?'text-emerald-400':t.status==='UNCERTAIN'?'text-red-400':'text-slate-300'}>{t.status}</strong> · {t.reason}{t.contractId?` · #${t.contractId}`:''}</div>)}</div>
   </div>
   <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='P/L' ? (pnl>0?'text-green-400':pnl<0?'text-red-500':'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
   <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
     <span className={topMomentum===null?'text-slate-400':topMomentum>0?'font-bold text-emerald-400':'font-bold text-rose-400'}>Momentum {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)}`}</span>
     <span className="text-slate-300">{strategy==='MOMENTUM_LOCK'?'Locked':'Next'} target {winConfirmed.current ? '—' : (strategy==='MOMENTUM_LOCK'?tradeLockView?.digit??'—':scores[0]?.digit??'—')}</span>
     {entryTimingView&&<span className="text-amber-200">{entryTimingView}</span>}
     {lastTrace&&<div className="w-full rounded-md border border-slate-600 bg-[#0a1222] p-2 text-[11px]">
       <div className="font-bold text-cyan-300">Contract #{lastTrace.contractId} · target {lastTrace.trace.target}</div>
       <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-slate-200">
         {lastTrace.trace.dnaProbability!==undefined&&<span>DNA p={(100*lastTrace.trace.dnaProbability).toFixed(1)}% · OOS LB {(100*(lastTrace.trace.dnaOutOfSampleLB??0)).toFixed(1)}%{lastTrace.trace.dnaHasEdge?' · EDGE':''}</span>}
         {lastTrace.trace.horizonProbability!==undefined&&<span>P3 {(100*lastTrace.trace.horizonProbability).toFixed(1)}% · LB {(100*(lastTrace.trace.shortHitRateLB??0)).toFixed(1)}%</span>}
         <span>gap {lastTrace.trace.horizonGapAtLock}/{(lastTrace.trace.horizonGapExpectation??0).toFixed(1)}</span>
         <span>entry {lastTrace.entryDigit??'?'} · expiry {lastTrace.expiryDigit??'?'}</span>
         <strong className={lastTrace.profit>0?'text-green-400':'text-red-400'}>{lastTrace.outcome} {lastTrace.profit>=0?'+':''}${lastTrace.profit.toFixed(2)}</strong>
       </div>
     </div>}
     <span className="text-slate-400">Open {outstandingCount} · ACK {inFlightCount} · At risk ${riskExposure.toFixed(2)}</span>
     {matchPaused && <strong className="text-yellow-300">MATCH HOLD</strong>}
     {active.current && <span className="text-slate-400">{entryStatus}</span>}
   </div>
   <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/70 p-2 text-xs text-slate-300">
     <span>Next-tick {accuracyAudit.trials?`${(100*accuracyAudit.hits/accuracyAudit.trials).toFixed(1)}%`:'—'} · Horizon {horizonAccuracy.trials?`${(100*horizonAccuracy.hits/horizonAccuracy.trials).toFixed(1)}%`:'—'} · DNA OOS {(100*dnaView.oosOverallAccuracy).toFixed(1)}%</span>
     <label className="flex items-center gap-1.5"><input type="checkbox" checked={requireEvidence} disabled={active.current||pending.current||outstandingCount>0} onChange={e=>setRequireEvidence(e.target.checked)} />Require V1 edge</label>
   </div>
   <div className="mt-2 flex items-center gap-2">
     <button disabled={!active.current && (!valid||!accountId||!isConnected||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')} onClick={() => { if(active.current) stop(); else start(); }} className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current?'bg-rose-600 hover:bg-rose-500':'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}>{active.current?'■ STOP CYCLE':'▶ START CYCLE'}</button>
     <button onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
   </div>
   {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">#{lastOutcome.id} · target {lastOutcome.digit}</span></div>}
   {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}</div>}
  </div></section>
}
