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
        if(c.is_sold || c.status==='won' || c.status==='lost'){
           // Latch a verified WIN before resolving the settlement promise.
           const settledProfit=Number(c.profit);
           const sold=Number(c.sell_price??c.payout);
           const cost=Number(c.buy_price);
           const verifiedWin=c.status==='won' ||
             ((c.is_sold || c.status==='won') &&
               (Number.isFinite(settledProfit)?settledProfit>0:
                 Number.isFinite(sold)&&Number.isFinite(cost)&&sold>cost));
           if(verifiedWin){
             verifiedWinContract.current=id;
             winConfirmed.current=true;
             halt.current=true;
             active.current=false;
             setStopReason(`Verified winning contract #${id}`);
             setEntryStatus(`WIN confirmed by Deriv on #${id} · no further purchases`);
             setMode('WIN');
           }
           finish(c);
         }
       };
       void ws.subscribe({proposal_open_contract:1,contract_id:id},handle)
        .then(sub=>{unsubscribe=sub.unsubscribe;if(done)void sub.unsubscribe()})
        .catch(()=>{
         if(done)return;
         const poll=async()=>{try{handle(await ws.send<any>({proposal_open_contract:1,contract_id:id}))}catch{}};
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
      else {
       confirmedLosses.current++;
       if(winConfirmed.current){setMode('WIN')}
       else if(countRef.current>=Number(limit)){setStopReason('Maximum purchases reached');halt.current=true;active.current=false;setMode('MAX_TRADES')}
       else if(-pnlRef.current+reservedStake.current>=Number(maxLoss)){setStopReason('Cycle loss/exposure limit reached');halt.current=true;active.current=false;setMode('MAX_LOSS')}
       else if(active.current&&!halt.current&&!matchPause.current&&!uncertainPurchase.current){setMode('RUNNING');setEntryStatus('Settled · next eligible tick may submit a buy');}
      }
      releaseMatchPause();
     }catch(e){setStopReason('Settlement could not be verified');halt.current=true;active.current=false;setMode('UNCERTAIN');setErr(`Contract ${id}: ${String(e)}. Reconcile in Deriv before restarting.`)}
     finally{if(unsubscribe)void unsubscribe();setOutstandingCount(outstanding.current.size);releaseMatchPause()}
    })();
   }catch(e){
    setStopReason('Purchase request failed or is uncertain');halt.current=true;active.current=false;
    if(purchaseAttempted){
      const msg=String(e);
      const isBalance=/balance|insufficient|not enough|not_enough/i.test(msg);
      if(isBalance){
        uncertainPurchase.current=false;
        reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
        recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED',msg,predicted,frozenTrace.tradingLockOriginSequence);
        setMode('STOPPED');
        setErr('Insufficient balance — cycle stopped, no contract was opened.');
      } else {
        recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'UNCERTAIN',msg,predicted,frozenTrace.tradingLockOriginSequence,contractId??null);
        uncertainPurchase.current=true;
        setMode('UNCERTAIN');
        setErr(`Purchase status unknown: ${msg}. Reconcile in Deriv.`);
      }
    } else {
      recordTick(signalSequence,tickEpoch,frozenTrace.signalObservedDigit,'REJECTED',String(e),predicted,frozenTrace.tradingLockOriginSequence);
      reservedStake.current=Math.max(0,amount(reservedStake.current-stake));
      setMode('STOPPED');
      setErr(`No trade was purchased: ${String(e)}`);
    }
   }finally{
     inFlight.current.delete(signalSequence);
     pendingCount.current=Math.max(0,pendingCount.current-1);
     pending.current=pendingCount.current>0;
     refreshExposure();
     releaseMatchPause();
   }
  },[ws,accountId,symbol,limit,maxLoss,play,pipSize,currency]);
  const execRef=useRef(execute);execRef.current=execute;
  useEffect(()=>{if(!isConnected && active.current){setStopReason('WebSocket disconnected');halt.current=true;active.current=false;setMode('UNCERTAIN');setErr('Connection lost. Verify outstanding contracts on Deriv before a new cycle.');}},[isConnected]);
  const tickSettings=useRef({pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizonTicks,minHorizonLift,minHorizonProbability,minOverdueRatio});
  tickSettings.current={pipSize,limit,threshold,minMomentum,base,factor,maxLoss,isConnected,accountId,symbol,strategy,lockDuration,horizonTicks,minHorizonLift,minHorizonProbability,minOverdueRatio};
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
    lastTickKey.current=key;
    seenTickKeys.current.add(key);
    seenTickOrder.current.push(key);
    if(seenTickOrder.current.length>256){const expired=seenTickOrder.current.shift();if(expired)seenTickKeys.current.delete(expired);}
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
    recordTick(sequence,epoch,digit,'SKIPPED','Processing tick');
    streamTicks.current=[...streamTicks.current.slice(-99),{epoch,digit,quote:Number(tick.quote),receivedAt}];
    tickStats.current.received++;
    if(tickStats.current.received%5===0){
      const ms=tickCadence.current.intervalMs;
      setCadenceLabel(ms===null?'Measuring tick interval':`${(ms/1000).toFixed(2)}s/tick · ${(1000/ms).toFixed(2)} ticks/s`);
      setStreamStatus(`Stream ${tickStats.current.received} ticks · duplicates ${tickStats.current.duplicates} · out of order ${tickStats.current.outOfOrder} · stale quotes ${tickStats.current.staleQuotes}`);
    }
    if(nextTickPending.current!==null){
      const hit=Number(digit===nextTickPending.current);
      eligibleResults.current=[...eligibleResults.current.slice(-499),hit];
      const n=eligibleResults.current.length;
      const hits=eligibleResults.current.reduce((a,b)=>a+b,0);
      setAccuracyAudit({trials:n,hits,lower95:wilsonLower(hits,n)});
    }
    nextTickPending.current=null;
    const horizonK=Number(settings.horizonTicks)||5;
    const stillPending:PendingHorizon[]=[];
    for(const p of pendingHorizonRef.current){
      if(sequence>p.expiresAtSeq){
        horizonResultsRef.current.push(p.hit?1:0);
        if(horizonResultsRef.current.length>1000)horizonResultsRef.current.shift();
      } else {
        if(sequence>p.frozenAtSeq && sequence<=p.expiresAtSeq && digit===p.topDigit)p.hit=true;
        stillPending.push(p);
      }
    }
    pendingHorizonRef.current=stillPending;
    histRef.current=[...histRef.current.slice(-99),digit];
    const ranking=intelligenceRef.current.observe(digit);scoreRef.current=ranking;
    horizonAnalyzerRef.current.observe(digit);
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
      if(sequence%5===0){
        setExecutionAudit(executionForecastRef.current.audit());
        setIntelligenceAudit(intelligenceRef.current.getAudit());
        const hr=horizonResultsRef.current;
        const trials=hr.length;
        const hits=trials?hr.reduce((a,b)=>a+b,0):0;
        setHorizonAccuracy({trials,hits,lower95:wilsonLower(hits,trials),horizon:horizonK,warmup:horizonAnalyzerRef.current.minGapSamples()});
        setHorizonRankingView(horizonRanking.slice(0,5));
      }
    });
    const top=ranking[0];
    const momentum=top?.momentum3 ?? null;
    const qualified=ranking.filter(row=>Number.isFinite(row.score) && row.score>=Number(settings.threshold) && row.momentum3>=Number(settings.minMomentum));
    const auditCandidate=top;
    if(auditCandidate && auditCandidate.score>=Number(settings.threshold) && auditCandidate.momentum3>=Number(settings.minMomentum)){nextTickPending.current=auditCandidate.digit;}
    const snapHist=histRef.current;
    queueMicrotask(()=>{if(scope.current!==telemetryScope)return;setHistory(snapHist);setScores(ranking);setTopMomentum(momentum);});
    let selected=lockRef.current;
    if(settings.strategy==='MOMENTUM_LOCK' && selected){
      selected={...selected,elapsed:selected.elapsed+1};
      if(selected.elapsed>Number(settings.lockDuration)){selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);}
      else{lockRef.current=selected;setLockPosition(selected.elapsed);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:selected.elapsed});}
    }else if(settings.strategy!=='MOMENTUM_LOCK' && selected){lockRef.current=null;selected=null;setLockPosition(0);setTradeLockView(null);}
    const displayTarget=settings.strategy==='MOMENTUM_LOCK' ? selected?.digit ?? top?.digit ?? null : top?.digit ?? null;
    const displayForecast=ranking.find(row=>row.digit===displayTarget);
    queueMicrotask(()=>{if(scope.current!==telemetryScope)return;setTargetMomentum(displayForecast?.momentum3??null);setTargetProbability(displayForecast?.probability??null);setTargetScore(displayForecast?.score??null);setTargetRises(displayForecast?.positiveSteps??null);});
    queueMicrotask(()=>{
      if(scope.current!==telemetryScope)return;
      publishForecastRef.current({symbol:settings.symbol,sequence,
        rows:ranking.map(row=>({digit:row.digit,score:row.score,probability:row.probability,momentum3:row.momentum3,positiveSteps:row.positiveSteps})),
        lockedDigit:settings.strategy==='MOMENTUM_LOCK' ? lockRef.current?.digit??null : null});
    });
    if(!active.current||halt.current||uncertainPurchase.current||!settings.accountId||!settings.isConnected){
      recordTick(sequence,epoch,digit,'SKIPPED',!active.current?'Cycle inactive':halt.current?'Cycle halted':uncertainPurchase.current?'Uncertain purchase':!settings.accountId?'No account':'Disconnected',lockRef.current?.digit??null,lockRef.current?.originSequence??null);return;
    }
    if(matchPause.current){recordTick(sequence,epoch,digit,'SKIPPED','Match pause active · awaiting settlement',lockRef.current?.digit??null,lockRef.current?.originSequence??null);return;}
    // FIX 2 — universal match detection for BOTH strategies:
    //   • MOMENTUM_LOCK → locked digit is the trade target.
    //   • DYNAMIC       → "locked digit" is the last submitted target;
    //                     once the observed digit equals it, pause all new
    //                     purchases until every in-flight contract settles.
    const activeTarget = settings.strategy==='MOMENTUM_LOCK'
      ? (lockRef.current?.digit ?? null)
      : (lockedRef.current ?? null);
    if(activeTarget !== null && digit===activeTarget){
      const originSeq = lockRef.current?.originSequence ?? null;
      if(outstanding.current.size>0 || pendingCount.current>0){
        matchPause.current=true;setMatchPaused(true);setMode('SETTLING');
        setEntryStatus(`${settings.strategy==='MOMENTUM_LOCK'?'Locked':'Last-target'} digit ${activeTarget} matched observed tick ${sequence} · pausing new trades until settlement`);
        recordTick(sequence,epoch,digit,'SKIPPED',`Target digit ${activeTarget} matched observed tick · pausing new trades until settlement`,activeTarget,originSeq);
      } else {
        recordTick(sequence,epoch,digit,'SKIPPED',`Target digit ${activeTarget} matched observed tick · skipping this tick`,activeTarget,originSeq);
      }
      return;
    }
    if(!ranking.length){skipPace('Forecast warming up');setEntryStatus('V1 warming up');return}
    if(countRef.current>=Number(settings.limit)){skipPace('Max trades reached');halt.current=true;active.current=false;setMode('MAX_TRADES');setStopReason('Maximum purchases reached');setEntryStatus('Max trades reached');return}
    const minLift=Number(settings.minHorizonLift);
    const minHorizonProb=Number(settings.minHorizonProbability);
    const minOverdue=Number(settings.minOverdueRatio);
    const horizonCandidates = horizonRanking
      .filter(r => qualified.some(q => q.digit===r.digit))
      .filter(r => r.lift >= minLift)
      .filter(r => r.horizonProbability >= minHorizonProb)
      .filter(r => r.overdueRatio >= minOverdue)
      .filter(r => r.gap >= 1);
    horizonCandidates.sort((a,b) => {
      const dp = b.horizonProbability - a.horizonProbability;
      if (Math.abs(dp) > 0.005) return dp;
      const doRatio = b.overdueRatio - a.overdueRatio;
      if (Math.abs(doRatio) > 0.05) return doRatio;
      return a.gapExpectation - b.gapExpectation;
    });
    const horizonChoice = horizonCandidates[0] ?? null;
    const nextCandidate = top && qualified.some(row=>row.digit===top.digit) ? top : null;
    const choiceForecast = horizonChoice
      ? (qualified.find(q => q.digit===horizonChoice.digit) ?? null)
      : nextCandidate;
    const choiceKind:EntryKind='NEXT';
    if(selected?.source!=='NEXT' && selected){selected=null;lockRef.current=null;setLockPosition(0);setTradeLockView(null);}
    if(settings.strategy==='MOMENTUM_LOCK' && !selected && choiceForecast && horizonChoice){
      selected={
        digit:choiceForecast.digit,elapsed:1,source:choiceKind,
        originSequence:sequence,originEpoch:epoch,
        signal:{score:choiceForecast.score,momentum3:choiceForecast.momentum3,positiveSteps:choiceForecast.positiveSteps,threshold:Number(settings.threshold)},
        gapAtLock:horizonChoice.gap,
        gapExpectation:horizonChoice.gapExpectation,
        horizonProb:horizonChoice.horizonProbability,
        horizonLift:horizonChoice.lift,
      };
      lockRef.current=selected;setLockPosition(1);setTradeLockView({digit:selected.digit,source:selected.source,elapsed:1});
    }
    if(!choiceForecast && !(settings.strategy==='MOMENTUM_LOCK' && selected)){
      const topLift=horizonRanking[0]?.lift??0;
      const topProb=horizonRanking[0]?.horizonProbability??0;
      skipPace(`No digit passes lift≥${minLift.toFixed(2)}× / P≥${(100*minHorizonProb).toFixed(0)}% / overdue≥${minOverdue.toFixed(2)}×`);
      setEntryStatus(`Waiting for a due digit · best P=${(100*topProb).toFixed(1)}% lift ${topLift.toFixed(2)}×`);
      return;
    }
    // FIX 1 — MOMENTUM_LOCK requires an acquired lock before `selected!.digit`.
    if(settings.strategy==='MOMENTUM_LOCK' && !selected){
      const bestP = horizonRanking[0]?.horizonProbability ?? 0;
      const bestLift = horizonRanking[0]?.lift ?? 0;
      skipPace(`Lock not yet acquired · best P(k)=${(100*bestP).toFixed(1)}% lift=${bestLift.toFixed(2)}×`);
      setEntryStatus('Waiting for due digit to acquire lock');
      return;
    }
    if(requireEvidenceRef.current && (eligibleResults.current.length<150 || wilsonLower(eligibleResults.current.reduce((a,b)=>a+b,0),eligibleResults.current.length)<=0.1)){
      skipPace('Evidence gate');setEntryStatus(`V1 evidence gate: ${eligibleResults.current.length}/150; lower bound must exceed 10%`);return;
    }
    const target=settings.strategy==='MOMENTUM_LOCK' ? selected!.digit : choiceForecast!.digit;
    const chosenForecast=ranking.find(row=>row.digit===target);
    const chosenHorizon=horizonRanking.find(row=>row.digit===target) ?? null;
    if(!chosenForecast){skipPace('Target unavailable');setEntryStatus('V1 target unavailable');return;}
    const ownMomentum=chosenForecast.momentum3;
    const ownRises=chosenForecast.positiveSteps;
    const ownRising=ownMomentum>=Number(settings.minMomentum);
    if(settings.strategy==='DYNAMIC' && (chosenForecast.score<Number(settings.threshold) || !ownRising)){
      skipPace('Score or rising momentum gate');
      setEntryStatus(`Dynamic NEXT ${target}: score ${chosenForecast.score.toFixed(2)}/${settings.threshold} · momentum ${ownMomentum.toFixed(2)}/${settings.minMomentum} · rises ${ownRises}/3`);
      return;
    }
    const signal={score:chosenForecast.score,momentum3:ownMomentum,positiveSteps:ownRises,threshold:Number(settings.threshold)};
    const signalKind:EntryKind='NEXT';
    const lockTick=settings.strategy==='MOMENTUM_LOCK'?selected!.elapsed:0;
    const firstLockMatch=false;
    if(sequence<=lastBuySignalSequence.current){return;}
    const stake=amount(Number(settings.base)*Math.pow(Number(settings.factor),countRef.current));
    if(!Number.isFinite(stake)||stake<=0||stake+reservedStake.current+Math.max(0,-pnlRef.current)>Number(settings.maxLoss)){
     skipPace('Next stake would exceed loss limit');stopRef.current();setMode('MAX_LOSS');return;
    }
    lastSignalDispatchMs.current=receivedAt;
    lockedRef.current=target;
    queueMicrotask(()=>setEntrySignal(signalKind));
    const frozenTrace:FrozenEntryTrace={
      strategy:settings.strategy,lockSource:settings.strategy==='MOMENTUM_LOCK'?selected!.source:null,
      signalKind,target,nextDigit:top?.digit??null,
      signalSequence:sequence,signalEpoch:epoch,signalObservedDigit:digit,
      signalReceivedAtIso:new Date().toISOString(),momentum:ownMomentum,
      score:chosenForecast.score,positiveSteps:ownRises,
      forecastProbability:Number.isFinite(chosenForecast.probability)?chosenForecast.probability:null,
      lockRemainingTicks:null,
      tradingLockOriginSequence:settings.strategy==='MOMENTUM_LOCK'?selected?.originSequence??null:null,
      tradingLockOriginEpoch:settings.strategy==='MOMENTUM_LOCK'?selected?.originEpoch??null:null,
      tradingLockOriginDigit:settings.strategy==='MOMENTUM_LOCK'?selected?.digit??null:null,
      horizonTicks:chosenHorizon?horizonK:undefined,
      horizonProbability:chosenHorizon?chosenHorizon.horizonProbability:undefined,
      horizonLift:chosenHorizon?chosenHorizon.lift:undefined,
      horizonRank:chosenHorizon?horizonRanking.findIndex(r=>r.digit===target)+1:undefined,
      horizonGapAtLock:chosenHorizon?chosenHorizon.gap:undefined,
      horizonGapExpectation:chosenHorizon?chosenHorizon.gapExpectation:undefined,
    };
    recordTick(sequence,epoch,digit,'ELIGIBLE',settings.strategy==='MOMENTUM_LOCK'?'Active NEXT-origin lock; new market tick':'Fresh qualified NEXT forecast',target,selected?.originSequence??null);
    queueMicrotask(publishPace);
    const previousCount=countRef.current;
    void execRef.current(target,stake,signal,epoch,sequence,receivedAt,settings.strategy,lockTick,settings.strategy==='MOMENTUM_LOCK'?Number(settings.lockDuration):0,firstLockMatch,signalKind,null,frozenTrace);
    if(settings.strategy==='MOMENTUM_LOCK' && selected && countRef.current>previousCount)lockPurchases.current.set(selected.originSequence,(lockPurchases.current.get(selected.originSequence)??0)+1);
    queueMicrotask(()=>{
      if(scope.current!==telemetryScope || !active.current || halt.current)return;
      setLockedDigit(target);setTargetRef.current(target);
      setEntryStatus(`${signalKind} sent on tick ${sequence} · ${pendingCount.current} ACK pending / ${outstanding.current.size} settling`);
    });
  },[]);

  const processMarketTickRef=useRef(processMarketTick);
  processMarketTickRef.current=processMarketTick;
  useEffect(()=>{
    if(!ws)return;
    // Register only when the socket object actually changes, not on Start/Stop
    // or on forecast/dashboard updates. currentTick remains a second feed.
    return ws.onMessage((frame:Record<string,unknown>)=>{
      if(frame.msg_type==='tick' && frame.tick)processMarketTickRef.current(frame.tick);
    });
  },[ws]);
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
   <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-cyan-300">⚡ DigitMatchStars Tick-Synchronized Rapid Engine</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${real?'bg-rose-900 text-rose-200':'bg-sky-900 text-sky-200'}`}>{real?'REAL MONEY':demo?'DEMO':'LOG IN'} · {mode}</span></div>
   <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-700/70 px-2 py-1.5 text-xs">
     <label className="flex items-center gap-2">Trade method
       <select value={strategy} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>{const v=e.target.value as Strategy;setStrategy(v);lockRef.current=null;setLockPosition(0);}} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white">
         <option value="DYNAMIC">Dynamic V1</option><option value="MOMENTUM_LOCK">Momentum Lock</option>
       </select>
     </label>
     <label className="flex items-center gap-2">Horizon k
       <select value={horizonTicks} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setHorizonTicks(e.target.value)} className="rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white">
         <option value="1">1 tick</option><option value="3">3 ticks</option><option value="4">4 ticks</option><option value="5">5 ticks</option>
       </select>
     </label>
     {strategy==='MOMENTUM_LOCK'&&<label className="flex items-center gap-2">Lock ticks <input type="number" min="1" max="9999" step="1" value={lockDuration} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setLockDuration(e.target.value)} className="w-16 rounded border border-slate-600 bg-[#0b1425] px-2 py-1 text-white" /></label>}
     {strategy==='MOMENTUM_LOCK'&&<span className="text-emerald-400">{tradeLockView?`Trading lock ${tradeLockView.digit} · ${tradeLockView.source} selection · tick ${tradeLockView.elapsed}/${lockDuration}`:'Waiting for due digit'}</span>}
   </div>
   <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{([['Base $',base,setBase],['Multiplier',factor,setFactor],['Max trades',limit,setLimit],['Loss limit $',maxLoss,setMaxLoss],['Min score',threshold,setThreshold],['Min momentum',minMomentum,setMinMomentum]] as const).map(([name,v,fn])=><label key={name} className="text-[11px] text-slate-300">{name}<input value={v} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} type="number" min={name==='Min momentum'||name==='Min score'?'0':undefined} step={name==='Min momentum'?'0.1':'any'} onChange={e=>fn(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>)}</div>
   <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
     <label className="text-[11px] text-slate-300">Min P(k) <input type="number" min="0" max="1" step="0.01" value={minHorizonProbability} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinHorizonProbability(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Min overdue ratio <input type="number" min="0" step="0.05" value={minOverdueRatio} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinOverdueRatio(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
     <label className="text-[11px] text-slate-300">Min horizon lift <input type="number" min="0" step="0.05" value={minHorizonLift} disabled={active.current||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN'} onChange={e=>setMinHorizonLift(e.target.value)} className="mt-1 w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-white"/></label>
   </div>
   {strategy==='MOMENTUM_LOCK'&&<div className="mt-2 rounded-lg border border-emerald-500/30 bg-[#0a1721] p-2 text-xs" aria-label="Momentum Lock trading status" aria-live="polite">
     <div className="mb-1 font-bold text-emerald-300">Momentum Lock · NEXT-only trading target</div>
     <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-200">
       <span>Active target <strong className="text-white">{tradeLockView?.digit??'—'}</strong></span>
       <span>Remaining <strong>{tradeLockView?Math.max(0,Math.max(1,Number(lockDuration)||1)-tradeLockView.elapsed+1):'—'}</strong> trading ticks</span>
       <span>Selected by <strong>{tradeLockView?.source??'—'}</strong></span>
       <span>Purchases this lock <strong>{lockRef.current?(lockPurchases.current.get(lockRef.current.originSequence)??0):0}</strong></span>
       <span>Status <strong className={mode==='RUNNING'&&!matchPaused&&!winConfirmed.current?'text-emerald-300':'text-amber-300'}>{mode==='UNCERTAIN'?'RECONCILIATION REQUIRED':winConfirmed.current||mode==='WIN'?'WIN CONFIRMED · STOPPED':matchPaused?'MATCH HOLD · VERIFYING SETTLEMENT':mode!=='RUNNING'?'NOT TRADING':!tradeLockView?'WAITING FOR DUE DIGIT':'ACTIVE · SAFETY GATES APPLY'}</strong></span>
     </div>
     <div className="mt-1 text-slate-400">{mode!=='RUNNING'&&<span>Stop reason: {stopReason}. </span>}{mode==='RUNNING'?`Latest execution decision: ${entryStatus}`:mode==='WIN'?'Cycle stopped after verified win. Start a new cycle to trade again.':`Purchases disabled: ${mode.toLowerCase().replace(/_/g,' ')}.`}</div>
   </div>}
   {horizonRankingView.length>0&&<div className="mt-2 rounded-md border border-violet-500/30 bg-[#0d1524] px-2 py-1.5 text-[11px]" aria-label="Horizon prediction diagnostic">
     <div className="font-semibold text-violet-300">Due digit diagnostic · k={horizonAccuracy.horizon} ticks</div>
     <div className="text-slate-400">Warm-up: {horizonAccuracy.warmup} gap samples per digit (need ≥5) · Uniform baseline P(k)={(100*(1-Math.pow(0.9,horizonAccuracy.horizon))).toFixed(1)}%</div>
     <div className="mt-1 font-mono text-[10px]">
       {horizonRankingView.map(r=><div key={r.digit} className="border-t border-slate-700/40 py-0.5">
         <span className="font-bold text-white">{r.digit}</span>{' · gap '}{r.gap}{' / mean '}{r.gapExpectation.toFixed(1)}{' · P'}{horizonAccuracy.horizon}{' '}{(100*r.horizonProbability).toFixed(1)}{'% · lift '}{r.lift.toFixed(2)}{'× · n='}{r.rawGapSamples}
       </div>)}
     </div>
     <div className="mt-1 text-slate-400">Measured horizon hit rate: <strong className="text-white">{horizonAccuracy.trials?`${(100*horizonAccuracy.hits/horizonAccuracy.trials).toFixed(1)}%`:'—'}</strong> ({horizonAccuracy.hits}/{horizonAccuracy.trials}) · Wilson 95% LB <strong className="text-white">{(100*horizonAccuracy.lower95).toFixed(1)}%</strong></div>
   </div>}
   <div className="mt-2 rounded-md border border-cyan-500/30 bg-[#091725] px-2 py-1.5 text-[11px] text-slate-200" aria-label="Tick-paced dispatch audit">
     <span className="font-semibold text-cyan-300">Tick-paced dispatch</span>
     <span className="ml-2">Dispatched <strong>{paceView.dispatched}</strong></span>
     <span className="ml-2">Accepted <strong>{paceView.accepted}</strong></span>
     <span className="ml-2">Skipped <strong>{paceView.skipped}</strong></span>
     <div className="text-slate-400">Last skipped: {paceView.lastSkip} · Last dispatched tick #{paceView.lastDispatchSequence||'—'} · {cadenceLabel}</div>
     <div className="mt-1 font-semibold text-cyan-300">Recent tick-to-purchase ledger</div>
     <div className="max-h-60 overflow-y-auto font-mono text-[10px]" aria-label="Tick purchase ledger">{ledgerView.map(t=><div key={t.sequence} className="border-t border-slate-700/40 py-0.5">#{t.sequence} · market {t.observedDigit} · target {t.target??'—'} · lock from #{t.lockOriginSequence??'—'} · <strong className={t.status==='ACCEPTED'?'text-emerald-400':t.status==='UNCERTAIN'?'text-red-400':'text-slate-300'}>{t.status}</strong> · {t.reason}{t.contractId?` · #${t.contractId}`:''}{t.entryDigit!==undefined?` · entry ${t.entryDigit??'?'} @ ${t.entryEpoch??'?'}`:''}{t.expiryDigit!==undefined?` · expiry ${t.expiryDigit??'?'} @ ${t.expiryEpoch??'?'}`:''}</div>)}</div>
   </div>
   <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">{[['Next-tick top',scores[0]?.digit??'—'],['Trade',`${count}/${limit}`],['Next stake',`$${next.toFixed(2)}`],['Cycle P/L',`${pnl>=0?'+':''}$${pnl.toFixed(2)}`]].map(([k,v])=><div key={String(k)} className="rounded-lg bg-[#0a1222] px-2 py-1.5"><div className="text-[11px] text-slate-400">{k}</div><div className={`font-extrabold ${k==='Cycle P/L' ? (pnl>0 ? 'text-green-400' : pnl<0 ? 'text-red-500' : 'text-slate-100') : 'text-slate-100'}`}>{v}</div></div>)}</div>
   <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
     <span className={topMomentum===null?'text-slate-400':topMomentum>0?'font-bold text-emerald-400':'font-bold text-rose-400'}>Momentum {topMomentum===null?'warming up':`${topMomentum>=0?'+':''}${topMomentum.toFixed(2)}`}</span>
     <span className="text-slate-300">{strategy==='MOMENTUM_LOCK' ? 'Locked target' : 'V1 next-tick target'} {winConfirmed.current ? '—' : (strategy==='MOMENTUM_LOCK' ? tradeLockView?.digit ?? '—' : scores[0]?.digit ?? '—')}</span>
     {entrySignal&&<span className="font-semibold text-white">Last entry: {strategy==='MOMENTUM_LOCK'?'Momentum Lock':'Dynamic V1'} · {entrySignal} selection</span>}
     {entryTimingView&&<span className="text-amber-200">Timing: {entryTimingView}</span>}
     {lastTrace&&<div className="w-full rounded-md border border-slate-600 bg-[#0a1222] p-2 text-[11px]" aria-label="Frozen contract signal audit">
       <div className="font-bold text-cyan-300">Verified contract trace · #{lastTrace.contractId}</div>
       <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-slate-200">
         <span>Method {lastTrace.trace.strategy==='MOMENTUM_LOCK'?'Momentum Lock':'Dynamic V1'} · target <strong>{lastTrace.trace.target}</strong></span>
         <span>At signal: NEXT {lastTrace.trace.nextDigit??'—'}</span>
         {lastTrace.trace.horizonProbability!==undefined&&<span>P({lastTrace.trace.horizonTicks}) {(100*lastTrace.trace.horizonProbability).toFixed(1)}% · lift {lastTrace.trace.horizonLift?.toFixed(2)}× · gap {lastTrace.trace.horizonGapAtLock}/{(lastTrace.trace.horizonGapExpectation??0).toFixed(1)}</span>}
         <span>Momentum {lastTrace.trace.momentum.toFixed(2)} · score {lastTrace.trace.score.toFixed(2)} · rises {lastTrace.trace.positiveSteps}/3</span>
         <span>Signal tick #{lastTrace.trace.signalSequence} · observed {lastTrace.trace.signalObservedDigit} · epoch {lastTrace.trace.signalEpoch}</span>
         <span>Deriv entry {lastTrace.entryDigit??'unknown'} · expiry {lastTrace.expiryDigit??'unknown'}</span>
         <strong className={lastTrace.profit>0?'text-green-400':'text-red-400'}>{lastTrace.outcome} {lastTrace.profit>=0?'+':''}${lastTrace.profit.toFixed(2)}</strong>
       </div>
       <div className="mt-1 text-slate-400">Frozen at dispatch. Deriv settlement determines WIN/LOSS.</div>
     </div>}
     <span className="text-slate-400">Open {outstandingCount} · ACK pending {inFlightCount} · At risk ${riskExposure.toFixed(2)}</span>
     {matchPaused && <strong className="text-yellow-300">MATCH HOLD · awaiting verified settlement</strong>}
     {active.current && <span className={/awaiting settlement/i.test(entryStatus) ? "font-semibold text-yellow-400" : "text-slate-400"}>{entryStatus}</span>}
     {mode==='UNCERTAIN'&&<span className="font-bold text-amber-300">Settlement needs verification</span>}
   </div>
   <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/70 p-2 text-xs text-slate-300">
     <span>Next-tick accuracy: <strong className="text-white">{accuracyAudit.trials ? `${(100*accuracyAudit.hits/accuracyAudit.trials).toFixed(1)}%` : '—'}</strong> ({accuracyAudit.hits}/{accuracyAudit.trials}) · Horizon accuracy: <strong className="text-white">{horizonAccuracy.trials?`${(100*horizonAccuracy.hits/horizonAccuracy.trials).toFixed(1)}%`:'—'}</strong> ({horizonAccuracy.hits}/{horizonAccuracy.trials})</span>
     <label className="flex items-center gap-1.5"><input type="checkbox" checked={requireEvidence} disabled={active.current || pending.current || outstandingCount>0} onChange={e=>setRequireEvidence(e.target.checked)} />Require measured edge</label>
   </div>
   <div className="mt-2 flex items-center gap-2">
     <button disabled={!active.current && (!valid||!accountId||!isConnected||pendingCount.current>0||outstandingCount>0||mode==='UNCERTAIN')} onClick={() => { if(active.current) stop(); else start(); }} className={`min-w-44 rounded-lg px-5 py-2.5 text-sm font-extrabold tracking-wide text-white shadow-lg transition disabled:opacity-30 ${active.current ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'}`}>{active.current ? '■ STOP CYCLE' : '▶ START CYCLE'}</button>
     <button aria-label={sound?'Mute sounds':'Enable sounds'} title={sound?'Mute':'Unmute'} onClick={()=>{setSound(v=>!v);if(!sound)tone('buy')}} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs text-emerald-300">{sound?'🔊':'🔇'}</button>
   </div>
   {lastOutcome&&<div className={`mt-3 rounded-lg border p-3 ${lastOutcome.outcome==='WIN'?'border-emerald-400 bg-emerald-500/20 text-emerald-300 shadow-lg shadow-emerald-950/30':'border-rose-500 bg-rose-500/10 text-rose-300'}`}><strong className="text-xl font-black tracking-wide">{lastOutcome.outcome==='WIN'?'🟢 WIN':'🔴 LOSS'} {lastOutcome.profit>=0?'+':''}${lastOutcome.profit.toFixed(2)}</strong><span className="ml-3 text-xs">Contract #{lastOutcome.id} · target {lastOutcome.digit}</span></div>}
   {err&&<div role="alert" className="mt-3 rounded-lg border border-amber-500 p-2 text-xs text-amber-300">{err}{mode==='UNCERTAIN'?' — Purchase outcome requires verification in Deriv before restarting.':''}</div>}
  </div></section>
}
