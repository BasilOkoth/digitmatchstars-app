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
 const field='w-full rounded-md border bg-background px-3 py-2';
 return <main className="mx-auto max-w-4xl space-y-5 p-6 text-foreground">
 <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">DigitMatchStars · Accumulator</h1><Link href="/" className="underline">Back to Digit Match</Link></div>
 <p className="rounded-md border p-3 text-sm">This dashboard controls a local Python execution process. It does not reuse your browser Deriv session. Set DERIV_TOKEN and DERIV_APP_ID on the local Python server, not in the browser. The strategy is unvalidated and may lose the entire stake.</p>
 <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
 <label>Account mode<select className={field} value={mode} onChange={e=>{setMode(e.target.value as 'demo'|'live');setConfirm(false);}}><option value="demo">Demo</option><option value="live">Live — real money</option></select></label>
 <label>Deriv account ID<input className={field} value={account} onChange={e=>setAccount(e.target.value)} placeholder={mode==='demo'?'Demo account ID':'Real account ID'}/></label>
 <label>Symbol<input className={field} value={symbol} onChange={e=>setSymbol(e.target.value)}/></label>
 <label>Stake (USD)<input className={field} type="number" min="0.01" step="0.01" value={stake} onChange={e=>setStake(e.target.value)}/></label>
 <label>Growth rate<select className={field} value={growth} onChange={e=>setGrowth(e.target.value)}>{[1,2,3,4,5].map(v=><option key={v} value={(v/100).toFixed(2)}>{v}%</option>)}</select></label>
 <label>Take profit (USD)<input className={field} type="number" min="0.01" step="0.01" value={takeProfit} onChange={e=>setTakeProfit(e.target.value)}/></label>
 <label>Max trades<input className={field} type="number" min="1" value={maxTrades} onChange={e=>setMaxTrades(e.target.value)}/></label>
 <label>Maximum loss (USD)<input className={field} type="number" min="0.01" step="0.01" value={maxLoss} onChange={e=>setMaxLoss(e.target.value)}/></label>
 </div>
 {mode==='live'&&<label className="flex items-center gap-2 rounded-md border p-3"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>I understand this will place real-money accumulator orders and can lose the entire stake.</label>}
 <div className="flex gap-3"><button className="rounded-md bg-green-700 px-5 py-2 text-white disabled:opacity-50" disabled={busy||!!status?.running||!account||mode==='live'&&!confirm} onClick={()=>void action('start')}>Start {mode==='live'?'LIVE':'Demo'}</button><button className="rounded-md border px-5 py-2 disabled:opacity-50" disabled={busy||!status?.running} onClick={()=>void action('stop')}>Stop bot</button><button className="rounded-md border px-5 py-2" onClick={()=>void refresh()}>Refresh</button></div>
 <p>Process: <strong>{status?.running?'RUNNING':status?'STOPPED':'UNKNOWN'}</strong>{status?.mode?` · ${status.mode.toUpperCase()} · ${status.account_id}`:''}</p>
 {error&&<p className="rounded-md border border-red-600 p-3 text-red-600">{error}</p>}
 <section><h2 className="mb-2 font-semibold">Execution log</h2><pre className="max-h-96 overflow-auto rounded-md border p-3 text-xs">{status?.logs?.map((l,i)=><div key={i}>{JSON.stringify(l)}</div>)}</pre></section>
 <p className="text-sm opacity-75">Stopping the process does not sell or settle an open contract. Verify open contracts directly in Deriv before restarting. Dashboard control requires a trusted local deployment; do not expose this endpoint publicly.</p>
 </main>;
}
