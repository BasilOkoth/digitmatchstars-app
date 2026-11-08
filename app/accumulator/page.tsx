'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
type Status = {running:boolean;mode:string|null;account_id:string|null;exit_code:number|null;logs:Record<string,unknown>[];error?:string};
export default function AccumulatorPage(){
 const [mode,setMode]=useState<'demo'|'live'>('demo');
 const [account,setAccount]=useState('');
 const [symbol,setSymbol]=useState('1HZ100V');
 const [stake,setStake]=useState('1');
 const [growth,setGrowth]=useState('0.02');
 const [takeProfit,setTakeProfit]=useState('0.20');
 const [maxTrades,setMaxTrades]=useState('3');
 const [maxLoss,setMaxLoss]=useState('3');
 const [confirm,setConfirm]=useState(false);
 const [status,setStatus]=useState<Status|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{try{const r=await fetch('/api/accumulator?action=status',{cache:'no-store'});const j=await r.json();if(!r.ok)throw Error(j.error||'Status unavailable');setStatus(j);setError('');}catch(e){setError(String(e));}},[]);
 useEffect(()=>{void refresh();const id=setInterval(()=>void refresh(),2000);return()=>clearInterval(id);},[refresh]);
 async function action(name:'start'|'stop'){
   setBusy(true);setError('');try{
    const body=name==='start'?JSON.stringify({mode,account_id:account,symbol,stake:Number(stake),growth:Number(growth),take_profit:Number(takeProfit),max_trades:Number(maxTrades),max_loss:Number(maxLoss),confirm_live:confirm}):undefined;
    const r=await fetch(`/api/accumulator?action=${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body});const j=await r.json();if(!r.ok)throw Error(j.detail||j.error||'Request failed');setStatus(j);
   }catch(e){setError(String(e));}finally{setBusy(false);}
 }
 const logs = status?.logs ?? [];
 const isLive = status?.mode === 'live';
 const field = 'mt-2 w-full rounded-xl border border-white/10 bg-[#111c31] px-3.5 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-400/70 focus:ring-2 focus:ring-cyan-400/10';
 const label = 'block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400';
 return <main className="min-h-screen bg-[#080e1b] text-slate-100 selection:bg-cyan-400/30">
  <div className="pointer-events-none fixed inset-0 opacity-50" style={{background:'radial-gradient(ellipse at 85% 0%,rgba(19,117,133,.20),transparent 48%),radial-gradient(ellipse at 0% 90%,rgba(72,57,146,.16),transparent 48%)'}} />
  <div className="relative mx-auto max-w-7xl space-y-6 px-4 py-7 sm:px-7 lg:px-10">
   <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-6">
    <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10 text-2xl font-black text-cyan-300">✦</div><div><div className="text-xs font-bold uppercase tracking-[.24em] text-cyan-300">DigitMatchStars / Trading Suite</div><h1 className="text-2xl font-black tracking-tight sm:text-3xl">Accumulator <span className="text-cyan-300">PRO</span></h1></div></div>
    <div className="flex items-center gap-3"><span className={'rounded-full border px-3 py-1.5 text-xs font-bold '+(status?.running?'border-emerald-400/30 bg-emerald-400/10 text-emerald-300':'border-slate-600 bg-slate-800 text-slate-300')}>{status?.running?'● ENGINE ACTIVE':'○ ENGINE IDLE'}</span><Link href="/" className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/10">← Digit Match</Link></div>
   </header>
   <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    {[{name:'Execution',value:status?.running?'RUNNING':'STOPPED',hint:'Engine state',tone:status?.running?'text-emerald-300':'text-slate-200'},{name:'Account',value:status?.mode?.toUpperCase()||mode.toUpperCase(),hint:status?.account_id||'Not connected',tone:isLive?'text-amber-300':'text-cyan-300'},{name:'Market',value:symbol,hint:'Synthetic index',tone:'text-slate-100'},{name:'Growth rate',value:`${(Number(growth)*100).toFixed(0)}%`,hint:'Per surviving tick',tone:'text-violet-300'}].map(card=><div key={card.name} className="rounded-2xl border border-white/10 bg-[#111a2b]/90 p-4 shadow-xl shadow-black/10"><p className="text-xs font-semibold uppercase tracking-widest text-slate-500">{card.name}</p><p className={'mt-3 break-all text-xl font-black sm:text-2xl '+card.tone}>{card.value}</p><p className="mt-1 truncate text-xs text-slate-400">{card.hint}</p></div>)}
   </div>
   <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]">
    <section className="rounded-3xl border border-white/10 bg-[#10192a]/95 p-5 shadow-2xl shadow-black/20 sm:p-7">
     <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">01 / Execution settings</p><h2 className="mt-1 text-xl font-bold">Trade configuration</h2></div><div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-200">Deriv ACCU · Tick driven</div></div>
     <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl bg-[#080e1b] p-1.5"><button className={'rounded-xl px-4 py-3 text-sm font-bold transition '+(mode==='demo'?'bg-cyan-500 text-slate-950':'text-slate-400 hover:bg-white/5')} onClick={()=>{setMode('demo');setConfirm(false)}} disabled={!!status?.running}>DEMO</button><button className={'rounded-xl px-4 py-3 text-sm font-bold transition '+(mode==='live'?'bg-amber-400 text-slate-950':'text-slate-400 hover:bg-white/5')} onClick={()=>{setMode('live');setConfirm(false)}} disabled={!!status?.running}>LIVE · REAL FUNDS</button></div>
     <div className="grid gap-4 sm:grid-cols-2">
      <label className={label}>Deriv account ID<input className={field} value={account} onChange={e=>setAccount(e.target.value)} placeholder={mode==='demo'?'Demo account ID':'Real account ID'} disabled={!!status?.running}/></label>
      <label className={label}>Trading symbol<input className={field} value={symbol} onChange={e=>setSymbol(e.target.value)} disabled={!!status?.running}/></label>
      <label className={label}>Stake (USD)<input className={field} type="number" min="0.01" step="0.01" value={stake} onChange={e=>setStake(e.target.value)} disabled={!!status?.running}/></label>
      <label className={label}>Growth rate<select className={field} value={growth} onChange={e=>setGrowth(e.target.value)} disabled={!!status?.running}>{[1,2,3,4,5].map(v=><option key={v} value={(v/100).toFixed(2)}>{v}% per tick</option>)}</select></label>
      <label className={label}>Take-profit (USD)<input className={field} type="number" min="0.01" step="0.01" value={takeProfit} onChange={e=>setTakeProfit(e.target.value)} disabled={!!status?.running}/></label>
      <label className={label}>Maximum trades<input className={field} type="number" min="1" step="1" value={maxTrades} onChange={e=>setMaxTrades(e.target.value)} disabled={!!status?.running}/></label>
      <label className={label}>Maximum loss (USD)<input className={field} type="number" min="0.01" step="0.01" value={maxLoss} onChange={e=>setMaxLoss(e.target.value)} disabled={!!status?.running}/></label>
     </div>
     {mode==='live'&&<label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100"><input className="mt-1 accent-amber-400" type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/><span>I confirm that this mode can place real-money orders. A barrier breach may lose the entire stake.</span></label>}
     <div className="mt-6 grid grid-cols-2 gap-3"><button className={'rounded-xl px-5 py-3.5 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 '+(mode==='live'?'bg-amber-400 text-slate-950 hover:bg-amber-300':'bg-cyan-400 text-slate-950 hover:bg-cyan-300')} disabled={busy||!!status?.running||!account||mode==='live'&&!confirm} onClick={()=>void action('start')}>{busy?'Working…':`▶ START ${mode.toUpperCase()}`}</button><button className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-5 py-3.5 text-sm font-bold text-rose-200 hover:bg-rose-400/20 disabled:opacity-40" disabled={busy||!status?.running} onClick={()=>void action('stop')}>■ STOP ENGINE</button></div>
     {error&&<div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}
    </section>
    <div className="space-y-5">
     <section className="rounded-3xl border border-white/10 bg-[#10192a]/95 p-5 sm:p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">02 / System health</p><h2 className="mt-1 text-xl font-bold">Execution monitor</h2></div><button className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/10" onClick={()=>void refresh()}>↻ Refresh</button></div><div className="mt-5 space-y-3"><div className="flex items-center justify-between rounded-xl bg-[#080e1b] p-4"><span className="text-sm text-slate-400">Control service</span><span className={'text-sm font-bold '+(status?'text-emerald-300':'text-amber-300')}>{status?'RESPONDING':'UNAVAILABLE'}</span></div><div className="flex items-center justify-between rounded-xl bg-[#080e1b] p-4"><span className="text-sm text-slate-400">Bot process</span><span className={'text-sm font-bold '+(status?.running?'text-emerald-300':'text-slate-300')}>{status?.running?'ACTIVE':'INACTIVE'}</span></div><div className="flex items-center justify-between rounded-xl bg-[#080e1b] p-4"><span className="text-sm text-slate-400">Exit code</span><span className="font-mono text-sm">{status?.exit_code??'—'}</span></div></div></section>
     <section className="rounded-3xl border border-amber-400/20 bg-amber-400/5 p-5 sm:p-6"><h3 className="font-bold text-amber-200">⚠ Live execution safeguards</h3><p className="mt-3 text-sm leading-6 text-slate-300">This panel controls a separate local Python service, not your browser Deriv session. A stop command does not sell an open contract. Verify open positions in Deriv before restarting. Do not expose the local control endpoint publicly.</p><p className="mt-3 text-xs text-amber-200/80">Momentum is an experimental entry filter, not a proven trading edge.</p></section>
    </div>
   </div>
   <section className="rounded-3xl border border-white/10 bg-[#10192a]/95 p-5 sm:p-7"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">03 / Activity stream</p><h2 className="mt-1 text-xl font-bold">Execution events <span className="ml-2 text-sm font-medium text-slate-500">({logs.length})</span></h2></div><span className="rounded-full border border-white/10 bg-[#080e1b] px-3 py-1.5 text-xs text-slate-400">Auto-refresh every 2 seconds</span></div><div aria-live="polite" className="max-h-[400px] min-h-[180px] space-y-2 overflow-auto rounded-2xl border border-white/5 bg-[#080e1b] p-3 font-mono text-xs">{logs.length?logs.slice(-80).reverse().map((event,i)=><div key={i} className="break-all rounded-lg border border-white/5 bg-white/[.025] px-3 py-2 text-slate-300">{JSON.stringify(event)}</div>):<div className="grid min-h-[150px] place-items-center text-center text-slate-500">No execution events yet. Start the engine to view activity.</div>}</div></section>
   <footer className="pb-5 text-center text-xs text-slate-500">DigitMatchStars · Accumulator PRO · Demo and Live execution require a locally configured Deriv API connection</footer>
  </div>
 </main>;
}
