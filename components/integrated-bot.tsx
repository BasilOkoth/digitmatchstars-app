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
type FrozenEntryTrace={strategy:Strategy;lockSource:EntryKind|null;signalKind:EntryKind;target:number;nextDigit:number|null;signalSequence:number;signalEpoch:number;signalObservedDigit:number;signalReceivedAtIso:string;momentum:number;score:number;positiveSteps:number;tradingLockOriginSequence:number|null;tradingLockOriginEpoch:number|null;tradingLockOriginDigit:number|null};

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

export function IntegratedBot({ws,accountId,accountType,isConnected,currentTick,pipSize,symbol,currency}:{ws:DerivWS|null;accountId:string|null;accountType:string|null;isConnected:boolean;currentTick:Tick|null;pipSize:number;symbol:string;currency?:string}){
  const {setTarget} = useExecutionTarget();
  const {publishForecast} = useEngineForecast();
  const demo=Boolean(accountId)&&(/demo|virtual/i.test(accountType??'')||/^VRT/i.test(accountId??''));const real=Boolean(accountId)&&!demo;
  const [strategy,setStrategy]=useState<Strategy>('DYNAMIC');const [lockDuration,setLockDuration]=useState('999');
  const lockPurchases=useRef(new Map<number,number>());
  const lockRef=useRef<{digit:number;elapsed:number;source:EntryKind;signal:{score:number;momentum3:number;positiveSteps:number;threshold:number};originSequence:number;originEpoch:number}|null>(null);
  const [lockPosition,setLockPosition]=useState(0);
  const [tradeLockView,setTradeLockView]=useState<{digit:number;source:EntryKind;elapsed:number}|null>(null);
  const [base,setBase]=useState('1');const [factor,setFactor]=useState('1.15');const [limit,setLimit]=useState('20');const [maxLoss,setMaxLoss]=useState('40');const [threshold,setThreshold]=useState('0');const [minMomentum,setMinMomentum]=useState('0');
  const [mode,setMode]=useState<Mode>('IDLE');const [count,setCount]=useState(0);const [pnl,setPnl]=useState(0);const [lastOutcome,setLastOutcome]=useState<Outcome|null>(null);const [err,setErr]=useState('');const [sound,setSound]=useState(true);
  const [history,setHistory]=useState<number[]>([]);const [scores,setScores]=useState<ReturnType<typeof scoreDigits>>([]);const [lockedDigit,setLockedDigit]=useState<number|null>(null);
  const intelligenceRef=useRef(new NextTickIntelligence());
  const [entrySignal,setEntrySignal]=useState<EntryKind|null>(null);
  const [lastTrace,setLastTrace]=useState<{trace:FrozenEntryTrace;contractId:number;entryDigit:number|null;expiryDigit:number|null;profit:number;outcome:'WIN'|'LOSS'}|null>(null);
  const executionForecastRef=useRef(new ExecutionAwareForecast());
  const outstanding=useRef(new Map<number,{digit:number;stake:number;signalEpoch:number;purchaseEpoch:number|null;}>());
  const reservedStake=useRef(0);
  const pendingCount=useRef(0);
  const inFlight=useRef(new Map<number,{digit:number;stake:number}>());
  const matchPause=useRef(false);
  const [matchPaused,setMatchPaused]=useState(false);
  const [riskExposure,setRiskExposure]=useState(0);
  const refreshExposure=()=>{setRiskExposure(reservedStake.current)};
  const releaseMatchPause=()=>{
    if(matchPause.current && pendingCount.current===0 && outstanding.current.size===0 && !uncertainPurchase.current && !winConfirmed.current){
      matchPause.current=false;setMatchPaused(false);
      if(active.current && !halt.current && !winConfirmed.current){setMode('RUNNING');setEntryStatus('All contracts settled · awaiting fresh tick')}
    }
  };
  const uncertainPurchase=useRef(false);
  const [entryStatus,setEntryStatus]=useState('Waiting for signal');
  const [stopReason,setStopReason]=useState('Not started');
  const winConfirmed=useRef(false);
  const verifiedWinContract=useRef<number|null>(null);
  const streamTicks=useRef<Array<{epoch:number;digit:number;quote:number;receivedAt:number}>>([]);
  const tickStats=useRef({received:0,outOfOrder:0,duplicates:0,staleQuotes:0});
  const tickSequence=useRef(0);
  const paceRef=useRef({eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—'});
  const seenTickKeys=useRef(new Set<string>());
  const seenTickOrder=useRef<string[]>([]);
  const tickCadence=useRef<{lastArrival:number|null;intervalMs:number|null}>({lastArrival:null,intervalMs:null});
  const [cadenceLabel,setCadenceLabel]=useState('Measuring tick interval');
  const [outstandingCount,setOutstandingCount]=useState(0);
  const [inFlightCount,setInFlightCount]=useState(0);
  const [sentCount,setSentCount]=useState(0);
  const active=useRef(false),halt=useRef(false),countRef=useRef(0),pnlRef=useRef(0),lastTickKey=useRef(''),histRef=useRef<number[]>([]),scoreRef=useRef<ReturnType<typeof scoreDigits>>([]),lockedRef=useRef<number|null>(null),scope=useRef('');
  const valid=Number.isInteger(Number(lockDuration))&&Number(lockDuration)>=1&&Number(lockDuration)<=9999&&Number(base)>0&&Number(factor)>=1&&Number(factor)<=3&&Number(limit)>=1&&Number(limit)<=100&&Number(maxLoss)>0&&Number(threshold)>=0&&minMomentum.trim()!==''&&Number.isFinite(Number(minMomentum))&&Number(minMomentum)>=0;
  const next=amount(Number(base)*Math.pow(Number(factor),countRef.current));const scopeKey=`${accountId}:${symbol}`;
  const soundRef=useRef(sound);useEffect(()=>{soundRef.current=sound},[sound]);
  const play=useCallback((kind:'buy'|'win'|'loss')=>{if(soundRef.current)tone(kind)},[]);
  const setTargetRef=useRef(setTarget);setTargetRef.current=setTarget;
  const publishForecastRef=useRef(publishForecast);publishForecastRef.current=publishForecast;
  const stop=useCallback(()=>{setStopReason('Stopped');halt.current=true;active.current=false;setTargetRef.current(null);setLockedDigit(null);lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setMode(m=>m==='RUNNING'?'STOPPED':m)},[]);
  const stopRef=useRef(stop);stopRef.current=stop;

  useEffect(()=>{if(scope.current!==scopeKey){const unsettled=outstanding.current.size>0||pendingCount.current>0||uncertainPurchase.current;scope.current=scopeKey;halt.current=true;active.current=false;histRef.current=[];scoreRef.current=[];intelligenceRef.current.reset();setEntrySignal(null);setLastTrace(null);if(!unsettled){countRef.current=0;setSentCount(0);pnlRef.current=0;}lockRef.current=null;setLockPosition(0);setTradeLockView(null);setLockedDigit(null);setTargetRef.current(null);if(!unsettled){pendingCount.current=0;inFlight.current.clear();matchPause.current=false;setMatchPaused(false);reservedStake.current=0;setRiskExposure(0);uncertainPurchase.current=false;}lastTickKey.current='';setEntryStatus('Waiting for signal');setStopReason('Account or symbol changed');paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—'};tickSequence.current=0;seenTickKeys.current.clear();seenTickOrder.current=[];tickCadence.current={lastArrival:null,intervalMs:null};setCadenceLabel('Measuring tick interval');streamTicks.current=[];tickStats.current={received:0,outOfOrder:0,duplicates:0,staleQuotes:0};setHistory([]);setScores([]);setCount(0);setPnl(0);setMode(unsettled?'UNCERTAIN':'IDLE');setLastOutcome(null);winConfirmed.current=false;verifiedWinContract.current=null;if(unsettled)setErr('Account/symbol changed with a pending or unsettled order. Reconcile on Deriv.');else setErr('')}},[scopeKey]);

  const execute=useCallback(async(predicted:number,stake:number,signal:{score:number;momentum3:number;positiveSteps:number;threshold:number},tickEpoch:number,signalSequence:number,signalReceivedAt:number,entryStrategy:Strategy,lockTick:number,lockWindow:number,frozenTrace:FrozenEntryTrace)=>{
   if(winConfirmed.current||verifiedWinContract.current!==null)return;
   if(!ws||!accountId||halt.current||!active.current||uncertainPurchase.current||countRef.current>=Number(limit))return;
   if(inFlight.current.has(signalSequence))return;
   pendingCount.current++;
   inFlight.current.set(signalSequence,{digit:predicted,stake});
   refreshExposure();
   let contractId:number|undefined;let purchaseAttempted=false;
   reservedStake.current=amount(reservedStake.current+stake);refreshExposure();
   try{
    if(tickSequence.current!==signalSequence||halt.current){reservedStake.current=Math.max(0,amount(reservedStake.current-stake));return;}
    purchaseAttempted=true;
    countRef.current++;setCount(countRef.current);setSentCount(countRef.current);
    const buyStart=performance.now();
    const buyPromise=ws.send<any>({buy:'1',price:amount(stake*1.05),parameters:{amount:stake,basis:'stake',contract_type:'DIGITMATCH',currency:currency??'USD',duration:1,duration_unit:'t',underlying_symbol:symbol,barrier:String(predicted)}});
    paceRef.current.dispatched++;
    setMode('BUYING');
    const bought=await buyPromise;
    const paid=Number(bought?.buy?.buy_price);const ask=Number.isFinite(paid)&&paid>0?paid:stake;
    const purchaseEpoch=Number(bought?.buy?.start_time??bought?.buy?.purchase_time??bought?.buy?.transaction_time);
    const acknowledgedEpoch=Number.isFinite(purchaseEpoch)&&purchaseEpoch>0?purchaseEpoch:null;
    contractId=Number(bought?.buy?.contract_id);
    if(!Number.isSafeInteger(contractId)||contractId<=0)throw new Error('Purchase acknowledged without verifiable contract ID');
    if(!Number.isFinite(ask)||ask<=0||ask>stake*1.05+0.001)throw new Error('Confirmed purchase price exceeds maximum');
    play('buy');
    reservedStake.current=amount(reservedStake.current-stake+ask);
    outstanding.current.set(contractId,{digit:predicted,stake:ask,signalEpoch:tickEpoch,purchaseEpoch:acknowledgedEpoch});
    paceRef.current.accepted++;setOutstandingCount(outstanding.current.size);
    if(!matchPause.current&&active.current&&!halt.current&&!winConfirmed.current&&!uncertainPurchase.current)setMode('RUNNING');
    const id=contractId;
         void (async()=>{
     let unsubscribe:(()=>Promise<void>)|undefined;
     try{
      const settle=await new Promise<any>((resolve,reject)=>{
       let done=false;let pollTimer:ReturnType<typeof setInterval>|undefined;
       const timeout=setTimeout(()=>finish(null,new Error(`Unconfirmed contract ${id}; reconciliation required`)),45000);
       function finish(c:any,error?:Error){if(done)return;done=true;clearTimeout(timeout);if(pollTimer)clearInterval(pollTimer);if(error)reject(error);else resolve(c);}
       const handle=(frame:Record<string,unknown>)=>{
        const c=(frame as any).proposal_open_contract;
        if(Number(c?.contract_id)!==id)return;
        if(c.is_sold||c.status==='won'||c.status==='lost'){
          const settledProfit=Number(c.profit);const sold=Number(c.sell_price??c.payout);const cost=Number(c.buy_price);
          const verifiedWin=c.status==='won'||((c.is_sold||c.status==='won')&&(Number.isFinite(settledProfit)?settledProfit>0:Number.isFinite(sold)&&Number.isFinite(cost)&&sold>cost));
          if(verifiedWin){verifiedWinContract.current=id;winConfirmed.current=true;halt.current=true;active.current=false;setStopReason(`Verified winning contract #${id}`);setMode('WIN');}
          finish(c);
        }
       };
       void ws.subscribe({proposal_open_contract:1,contract_id:id},handle).then(sub=>{unsubscribe=sub.unsubscribe;if(done)void sub.unsubscribe()}).catch(()=>{if(done)return;const poll=async()=>{try{handle(await ws.send<any>({proposal_open_contract:1,contract_id:id}))}catch{}};pollTimer=setInterval(()=>void poll(),1200);void poll();});
      });
      const payout=Number(settle.sell_price??settle.payout);const buyPrice=Number(settle.buy_price??ask);
      if(!Number.isFinite(payout)||!Number.isFinite(buyPrice)||payout<0||buyPrice<=0)throw new Error('Settlement amounts unavailable');
      const profit=amount(payout-buyPrice);pnlRef.current=amount(pnlRef.current+profit);setPnl(pnlRef.current);
      const win=profit>0;executionForecastRef.current.observeSettlement(win);
      const expiryDigit=expiryDigitOf(settle,pipSize);
      const entryDigit=spotDigit(settle.entry_spot??settle.entry_tick??null,pipSize);
      setLastTrace({trace:frozenTrace,contractId:id,entryDigit,expiryDigit,profit,outcome:win?'WIN':'LOSS'});
      setLastOutcome({id,digit:predicted,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS',expiryDigit,expiryEpoch:null,signalEpoch:tickEpoch,purchaseEpoch:null});play(win?'win':'loss');
      const journalRow={frozenTrace,entryKind:'NEXT' as EntryKind,strategy:entryStrategy,lockTick,lockDuration:lockWindow,signalEpoch:tickEpoch,purchaseEpoch:null,expiryEpoch:null,expiryDigit,recordType:'TRADE' as const,contractId:id,accountId,symbol,timestamp:new Date().toISOString(),targetDigit:predicted,score:signal.score,momentum3:signal.momentum3,positiveSteps:signal.positiveSteps,threshold:signal.threshold,stake:buyPrice,payout,profit,outcome:win?'WIN':'LOSS' as const};
      try{const key=`dms-momentum-trades:v1:${symbol}`;const prev=JSON.parse(localStorage.getItem(key)||'[]');const rows=Array.isArray(prev)?prev:[];if(!rows.some((x:any)=>x.contractId===id&&x.accountId===accountId))localStorage.setItem(key,JSON.stringify([...rows.slice(-4999),journalRow]))}catch{}
      outstanding.current.delete(id);reservedStake.current=Math.max(0,amount(reservedStake.current-ask));setOutstandingCount(outstanding.current.size);refreshExposure();
      if(win){setStopReason('Verified winning contract');winConfirmed.current=true;halt.current=true;active.current=false;matchPause.current=false;setMatchPaused(false);lockedRef.current=null;lockRef.current=null;setLockedDigit(null);setLockPosition(0);setTradeLockView(null);setTargetRef.current(null);setMode('WIN')}
      else{confirmedLossesRef.current++;if(countRef.current>=Number(limit)){halt.current=true;active.current=false;setMode('MAX_TRADES')}else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){halt.current=true;active.current=false;setMode('MAX_LOSS')}else if(active.current&&!halt.current&&!matchPause.current&&!uncertainPurchase.current){setMode('RUNNING');setEntryStatus('Settled · next tick may submit a buy');}}
      releaseMatchPause();
     }catch(e){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv.`)}
     finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size);releaseMatchPause()}
    })();
   }catch(e){halt.current=true;active.current=false;
    if(purchaseAttempted){uncertainPurchase.current=true;setMode('UNCERTAIN');setErr(`Purchase status unknown: ${String(e)}. Reconcile in Deriv.`)}
    else{reservedStake.current=Math.max(0,amount(reservedStake.current-stake));setMode('STOPPED');setErr(`No trade purchased: ${String(e)}`)}
   }finally{inFlight.current.delete(signalSequence);pendingCount.current=Math.max(0,pendingCount.current-1);refreshExposure();releaseMatchPause()}
  },[ws,accountId,symbol,limit,maxLoss,play,pipSize,currency]);
  const confirmedLossesRef=useRef(0);
  const execRef=useRef(execute);execRef.current=execute;

  useEffect(()=>{if(!isConnected&&active.current){halt.current=true;active.current=false;setMode('UNCERTAIN');setErr('Connection lost.');}},[isConnected]);

  const tickSettings=useRef({pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration});
  tickSettings.current={pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration};

  const processMarketTick=useCallback((tick:any)=>{
    const settings=tickSettings.current;
    if(tick.symbol && tick.symbol!==settings.symbol)return;
    if(!settings.symbol || !Number.isFinite(Number(tick.quote)))return;
    const epoch=Number(tick.epoch);if(!Number.isFinite(epoch))return;
    const key=`${epoch}:${Number(tick.quote)}`;
    if(seenTickKeys.current.has(key)){tickStats.current.duplicates++;return}
    const prevEpoch=Number(lastTickKey.current.split(':')[0]);
    if(lastTickKey.current && Number.isFinite(prevEpoch) && epoch<prevEpoch){tickStats.current.outOfOrder++;return;}
    if(epoch*1000<Date.now()-15000 || epoch*1000>Date.now()+15000){tickStats.current.staleQuotes++;return;}
    lastTickKey.current=key;seenTickKeys.current.add(key);seenTickOrder.current.push(key);
    if(seenTickOrder.current.length>256){const expired=seenTickOrder.current.shift();if(expired)seenTickKeys.current.delete(expired);}
    const digit=getLastDigit(Number(tick.quote),Number.isInteger(tick.pip_size)?tick.pip_size:settings.pipSize);
    const receivedAt=performance.now();
    const previousArrival=tickCadence.current.lastArrival;
    if(previousArrival!==null){const interval=receivedAt-previousArrival;if(interval>0&&interval<15000){const prev=tickCadence.current.intervalMs;tickCadence.current.intervalMs=prev===null?interval:(prev*0.75+interval*0.25);}}
    tickCadence.current.lastArrival=receivedAt;
    const sequence=++tickSequence.current;
    streamTicks.current=[...streamTicks.current.slice(-99),{epoch,digit,quote:Number(tick.quote),receivedAt}];
    tickStats.current.received++;
    if(tickStats.current.received%5===0){const ms=tickCadence.current.intervalMs;setCadenceLabel(ms===null?'Measuring tick interval':`${(ms/1000).toFixed(2)}s/tick · ${(1000/ms).toFixed(2)} ticks/s`);}
    histRef.current=[...histRef.current.slice(-99),digit];
    const ranking=intelligenceRef.current.observe(digit);scoreRef.current=ranking;
    const top=ranking[0];const momentum=top?.momentum3??null;
    queueMicrotask(()=>{if(scope.current!==scope.current)return;setHistory(histRef.current);setScores(ranking);});
    let selected=lockRef.current;
    if(settings.strategy==='MOMENTUM_LOCK' && selected){
      selected={...selected,elapsed:selected.elapsed+1};
      if(selected.elapsed>Number(settings.lockDuration)){selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);}
      else{lockRef.current=selected;setLockPosition(selected.elapsed);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:selected.elapsed});}
    }else if(settings.strategy!=='MOMENTUM_LOCK' && selected){lockRef.current=null;selected=null;setLockPosition(0);setTradeLockView(null);}
    queueMicrotask(()=>{publishForecastRef.current({symbol:settings.symbol,sequence,rows:ranking.map(row=>({digit:row.digit,score:row.score,probability:row.probability,momentum3:row.momentum3,positiveSteps:row.positiveSteps})),lockedDigit:settings.strategy==='MOMENTUM_LOCK'?lockRef.current?.digit??null:null});});
    if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected){setEntryStatus(!active.current?'Cycle inactive':halt.current?'Cycle halted':uncertainPurchase.current?'Uncertain purchase':'Disconnected');return;}
    if(matchPause.current){return;}
    const activeTarget=settings.strategy==='MOMENTUM_LOCK'?(lockRef.current?.digit??null):(lockedRef.current??null);
    if(activeTarget!==null && digit===activeTarget){
      if(outstanding.current.size>0||pendingCount.current>0){matchPause.current=true;setMatchPaused(true);setMode('SETTLING');setEntryStatus(`Locked ${activeTarget} matched observed · pausing for settlement`);}
      return;
    }
    if(!ranking.length){setEntryStatus('Warming up');return}
    if(countRef.current>=Number(settings.limit)){halt.current=true;active.current=false;setMode('MAX_TRADES');setStopReason('Max trades reached');return}
    const qualified=ranking.filter(row=>Number.isFinite(row.score) && row.score>=Number(settings.threshold) && row.momentum3>=Number(settings.minMomentum));
    const nextCandidate=top && qualified.some(row=>row.digit===top.digit)?top:null;
    const choice=settings.strategy==='MOMENTUM_LOCK' ? (selected ? {digit:selected.digit,score:selected.signal.score,momentum3:selected.signal.momentum3,positiveSteps:selected.signal.positiveSteps,probability:0} : nextCandidate) : nextCandidate;
    if(!choice){setEntryStatus('Waiting for qualified signal');return}
    if(settings.strategy==='MOMENTUM_LOCK' && !selected){
      lockRef.current={digit:choice.digit,elapsed:1,source:'NEXT',originSequence:sequence,originEpoch:epoch,signal:{score:choice.score,momentum3:choice.momentum3,positiveSteps:choice.positiveSteps,threshold:Number(settings.threshold)}};
      selected=lockRef.current;setLockPosition(1);setTradeLockView({digit:selected.digit,source:'NEXT',elapsed:1});
    }
    const target=choice.digit;
    // ── PER-DISPATCH SCORE + MOMENTUM GATE (Dynamic V1 only) ────────────
    // Dynamic V1 re-ranks every tick, so the gate must apply every tick.
    // Momentum Lock is a commitment: once a lock is acquired, it fires on
    // the frozen digit every tick regardless of drift until win / max
    // trades / loss limit. The gate applies only at lock acquisition (the
    // `qualified` filter above). Do not gate the locked digit per tick.
    if (settings.strategy === 'DYNAMIC') {
      const dispatchForecast = ranking.find(row => row.digit === target);
      if (!dispatchForecast) {
        setEntryStatus(`Target ${target} unavailable in current ranking`);
        return;
      }
      if (dispatchForecast.score < Number(settings.threshold)) {
        setEntryStatus(`Skipped: ${target} score ${dispatchForecast.score.toFixed(2)} < ${settings.threshold}`);
        return;
      }
      if (dispatchForecast.momentum3 < Number(settings.minMomentum)) {
        setEntryStatus(`Skipped: ${target} momentum ${dispatchForecast.momentum3.toFixed(2)} < ${settings.minMomentum}`);
        return;
      }
    }
    // ── END PER-DISPATCH GATE ───────────────────────────────────────────
    const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
    if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){setStopReason('Stake would exceed loss limit');stopRef.current();setMode('MAX_LOSS');return;}
    lockedRef.current=target;
    queueMicrotask(()=>setEntrySignal('NEXT'));
    const frozenTrace:FrozenEntryTrace={strategy:settings.strategy,lockSource:selected?.source??null,signalKind:'NEXT',target,nextDigit:top?.digit??null,signalSequence:sequence,signalEpoch:epoch,signalObservedDigit:digit,signalReceivedAtIso:new Date().toISOString(),momentum:choice.momentum3,score:choice.score,positiveSteps:choice.positiveSteps,tradingLockOriginSequence:selected?.originSequence??null,tradingLockOriginEpoch:selected?.originEpoch??null,tradingLockOriginDigit:selected?.digit??null};
    queueMicrotask(()=>{if(scope.current!==scope.current)return;setLockedDigit(target);setTargetRef.current(target);setEntryStatus(`${settings.strategy==='MOMENTUM_LOCK'?'Momentum':'Dynamic'} sent ${target} on tick ${sequence}`);});
    void execRef.current(target,stake,{score:choice.score,momentum3:choice.momentum3,positiveSteps:choice.positiveSteps,threshold:Number(settings.threshold)},epoch,sequence,receivedAt,settings.strategy,selected?.elapsed??0,Number(settings.lockDuration),frozenTrace);
  },[]);

  const processMarketTickRef=useRef(processMarketTick);processMarketTickRef.current=processMarketTick;
  useEffect(()=>{if(!ws)return;return ws.onMessage((frame:Record<string,unknown>)=>{if(frame.msg_type==='tick'&&frame.tick)processMarketTickRef.current(frame.tick);});},[ws]);
  useEffect(()=>{if(!isConnected||!currentTick||!symbol)return;processMarketTick({...currentTick,symbol});},[currentTick,symbol,isConnected,processMarketTick]);

  function start(){
   if(!valid||!accountId||!isConnected||!ws||pendingCount.current>0||active.current||uncertainPurchase.current||outstanding.current.size)return;
   const acc=real?'REAL MONEY':'DEMO';
   if(real&&!window.confirm(`REAL MONEY: Automated DigitMatch on ${symbol}. Max loss $${maxLoss}. Confirm.`))return;
   if(!window.confirm(`Start ${acc} cycle? 1-tick DIGITMATCH, one buy per tick. Max loss $${maxLoss}, max ${limit} buys.`))return;
   if(mode==='UNCERTAIN'||uncertainPurchase.current||pendingCount.current>0||outstanding.current.size>0)return;
   paceRef.current={eligible:0,dispatched:0,accepted:0,skipped:0,lastSkip:'—'};tickSequence.current=0;
   lockPurchases.current.clear();setEntryStatus('Waiting for signal');setStopReason('Running');countRef.current=0;setSentCount(0);pnlRef.current=0;reservedStake.current=0;setRiskExposure(0);matchPause.current=false;setMatchPaused(false);confirmedLossesRef.current=0;lockedRef.current=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);setCount(0);setPnl(0);setLockedDigit(null);setTargetRef.current(null);setLastOutcome(null);winConfirmed.current=false;verifiedWinContract.current=null;setErr('');halt.current=false;active.current=true;setMode('RUNNING');if(sound)tone('buy');
  }
  return <section className="w-full min-w-0 px-0 pb-2 text-slate-100"><div className="rounded-xl border border-cyan-500/30 bg-[#101a2e] p-2.5 shadow-lg shadow-black/30">
   <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL':'DEMO'} · {mode}</span></div>
   <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
     <label className="flex items-center gap-2">Method<select value={strategy} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>{const v=e.target.value as Strategy;setStrategy(v);lockRef.current=null;setLockPosition(0)}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white"><option value="DYNAMIC">Dynamic V1</option><option value="MOMENTUM_LOCK">Momentum Lock</option></select></label>
     {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Lock ticks<input type="number" min="1" max="9999" step="1" value={lockDuration} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setLockDuration(e.target.value)} className="w-16 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white"/></label>}
     {strategy==='MOMENTUM_LOCK'&&<span className="text-emerald-400">{tradeLockView?`Lock ${tradeLockView.digit} · tick ${tradeLockView.elapsed}/${lockDuration}`:'Waiting for lock'}</span>}
   </div>
   <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
   <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Top',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='P/L'?(pnl>0?'text-green-400':pnl<0?'text-red-500':'text-slate-100'):'text-slate-100'}`}>{v}</div></div>)}</div>
   <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
     <span className="text-slate-400">Sent <strong className="text-white">{paceRef.current.dispatched}</strong> · Acc <strong className="text-white">{paceRef.current.accepted}</strong> · Open <strong className="text-white">{outstandingCount}</strong> · Risk <strong className="text-white">${riskExposure.toFixed(2)}</strong> · {cadenceLabel}</span>
     {matchPaused&&<strong className="text-yellow-300">MATCH HOLD</strong>}
     {active.current&&<span className="text-slate-400">{entryStatus}</span>}
   </div>
   <div className="mt-2 flex items-center gap-2">
     <button disabled={!active.current && (!valid||!accountId||!isConnected||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')} onClick={() => { if(active.current) stop(); else start(); }} className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold text-white ${active.current?'bg-rose-600 hover:bg-rose-500':'bg-emerald-600 hover:bg-emerald-500'}`}>{active.current?'■ STOP CYCLE':'▶ START CYCLE'}</button>
     <button onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
   </div>
   {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">#{lastOutcome.id} · target {lastOutcome.digit}</span></div>}
   {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}</div>}
  </div></section>
}
