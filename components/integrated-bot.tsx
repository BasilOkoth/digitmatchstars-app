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
  <div className="mt-2 rounded-md border border-cyan-500/30 bg-[#091725] px-2 py-1.5 text-[11px] text-slate-200" aria-label="Tick-paced dispatch audit">
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
