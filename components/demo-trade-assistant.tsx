'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ClosedPosition } from '@/lib/types';

/** Both account types use the existing authenticated Deriv buy action.
 * Every contract needs an explicit confirmation. No unattended live purchases.
 * We do not assert that a submitted contract settled until the statement confirms it.
 */
export function DemoTradeAssistant({
  accountType, accountId, symbol, proposalPrice, isConnected, isBuying, buyContract,
  buyError, closedPositions, contractMode, stake, setStake, duration,
}: {
  accountType: string | null | undefined;
  accountId: string | null | undefined;
  symbol: string;
  proposalPrice: number | null;
  isConnected: boolean;
  isBuying: boolean;
  buyContract: () => Promise<void>;
  buyError: string | null;
  closedPositions: ClosedPosition[];
  contractMode: string;
  stake: string;
  setStake: (value: string) => void;
  duration: number;
}) {
  const isDemo = /demo|virtual/i.test(accountType ?? '') || /^VRT/i.test(accountId ?? '');
  const isReal = Boolean(accountId) && !isDemo;
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [showHistory,setShowHistory] = useState(false);
  const [realEnabled,setRealEnabled] = useState(false);
  const [base,setBase] = useState('1');
  const [multiplier,setMultiplier] = useState('1.15');
  const [maxTrades,setMaxTrades] = useState('20');
  const [maxLoss,setMaxLoss] = useState('20');
  const [scoreThreshold,setScoreThreshold] = useState('15.01');
  const [cycleTrades,setCycleTrades] = useState(0);
  const [cyclePnL,setCyclePnL] = useState(0);
  const [waiting,setWaiting] = useState<{at:number; ids:number[]} | null>(null);
  const [lastResolved,setLastResolved] = useState<number | null>(null);
  const scope = `${accountId ?? 'guest'}:${symbol}`;
  const scopeRef = useRef(scope);
  const latest=useMemo(()=>closedPositions.filter(p=>p.underlying_symbol===symbol).sort((a,b)=>b.sell_time-a.sell_time).slice(0,4),[closedPositions,symbol]);
  const resolved=useMemo(()=>waiting ? closedPositions.find(p=> p.underlying_symbol===symbol && !waiting.ids.includes(p.contract_id) && p.purchase_time*1000 >= waiting.at-5000) : undefined,[waiting,closedPositions,symbol]);
  useEffect(()=>{
    if(scopeRef.current!==scope){
      scopeRef.current=scope;setWaiting(null);setRealEnabled(false);setCycleTrades(0);setCyclePnL(0);setLastResolved(null);setNotice('');
    }
  },[scope]);
  useEffect(()=>{
    if(!waiting || !resolved || lastResolved===resolved.contract_id) return;
    setLastResolved(resolved.contract_id);
    setWaiting(null);
    const profit=Number(resolved.sell_price||0)-Number(resolved.buy_price||0);
    setCyclePnL(v=>Math.round((v+profit)*100)/100);
    if(profit>0){ setNotice(`WIN confirmed: +$${profit.toFixed(2)}. Cycle stopped.`); }
    else {setNotice(`LOSS confirmed: -$${Math.abs(profit).toFixed(2)}. Review the cycle limits before your next order.`);}
  },[waiting,resolved,lastResolved]);
  const baseN=Number(base),multN=Number(multiplier),maxN=Number(maxTrades),lossN=Number(maxLoss);
  const valid=Number.isFinite(baseN)&&baseN>0&&Number.isFinite(multN)&&multN>=1&&multN<=3&&Number.isInteger(maxN)&&maxN>0&&maxN<=100&&Number.isFinite(lossN)&&lossN>0;
  const cycleComplete=(cycleTrades>=maxN)||cyclePnL<=-lossN || (lastResolved!==null && notice.startsWith('WIN confirmed'));
  const nextStake=valid?Math.round(baseN*Math.pow(multN,cycleTrades)*100)/100:0;
  const canOrder=!!accountId && (isDemo || (isReal&&realEnabled)) && isConnected && !isBuying && !busy && !waiting && proposalPrice!==null && valid && !cycleComplete && nextStake<=lossN+cyclePnL && Number(stake)===nextStake;
  async function placeOrder(){
    if(!canOrder)return;
    const mode=isDemo?'DEMO':'REAL MONEY';
    if(!window.confirm(`${mode}: BUY ONE ${contractMode} contract on ${symbol}?\nStake: $${stake}; duration ${duration} ticks.\nCycle trades: ${cycleTrades+1}/${maxN}. Max cycle loss: $${lossN}.\nAn order may lose its entire stake.`))return;
    setBusy(true);setNotice('Submitting contract…');
    const snapshot={at:Date.now(),ids:closedPositions.map(p=>p.contract_id)};
    // Fail closed even when buy API rejects: the exchange may have accepted the request.
    setWaiting(snapshot);
    try { await buyContract();setCycleTrades(v=>v+1);setNotice('Order submitted. Awaiting confirmed settlement.'); }
    catch(e){setNotice(`Uncertain purchase outcome: ${String(e)}. Check Deriv contract history before continuing.`);}
    finally {setBusy(false);}
  }
  return <section className="mx-auto w-full max-w-7xl px-3 pb-2 sm:px-4" aria-label="Trading center">
    <div className="rounded-xl border border-cyan-400/25 bg-[#101a2e] p-3 text-slate-100">
      <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-base font-bold text-cyan-300">⚡ Trade Center</h2><span className={`rounded-full px-2 py-1 text-xs font-bold ${isDemo?'bg-cyan-500/20 text-cyan-300':isReal?'bg-rose-500/20 text-rose-300':'bg-slate-700'}`}>{isDemo?'DEMO':isReal?'REAL MONEY':'LOG IN'}</span></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Field label="Base $" value={base} set={setBase}/><Field label="Multiplier" value={multiplier} set={setMultiplier}/><Field label="Max trades" value={maxTrades} set={setMaxTrades}/><Field label="Max loss $" value={maxLoss} set={setMaxLoss}/><Field label="Score threshold" value={scoreThreshold} set={setScoreThreshold}/>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Threshold {scoreThreshold} is a saved configuration only: AI scoring is not connected. Orders require a separate confirmation; no automatic threshold execution.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs"><span>Trades <strong>{cycleTrades}/{valid?maxN:'—'}</strong></span><span>Cycle P/L <strong className={cyclePnL>=0?'text-emerald-400':'text-rose-400'}>{cyclePnL>=0?'+':''}${cyclePnL.toFixed(2)}</strong></span><span>Next stake <strong>${nextStake.toFixed(2)}</strong></span><button type="button" className="text-cyan-300 underline" onClick={()=>{if(!waiting&&window.confirm('Reset cycle counters?')){setCycleTrades(0);setCyclePnL(0);setLastResolved(null);setNotice('');setStake(baseN.toFixed(2));}}}>Reset cycle</button></div>
      {isReal && <label className="mt-3 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200"><input type="checkbox" checked={realEnabled} onChange={e=>setRealEnabled(e.target.checked)}/> Enable REAL MONEY orders for this account (each order still needs confirmation)</label>}
      <div className="mt-3 flex flex-wrap items-center gap-2"><Button disabled={!canOrder} onClick={placeOrder} className="bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy?'Submitting…':waiting?'Awaiting settlement':isReal?'Place ONE Real Trade':'Place ONE Demo Trade'}</Button><button type="button" onClick={()=>setStake(nextStake.toFixed(2))} className="rounded-md border border-cyan-500/40 px-3 py-2 text-xs text-cyan-200">Apply next stake</button><span className="text-xs text-slate-400">{!accountId?'Log in to trade':!valid?'Check cycle settings':waiting?'Awaiting Deriv record':cycleComplete?'Cycle stopped':Number(stake)!==nextStake?'Apply next stake first':!isConnected?'Connecting…':'Ready'}</span></div>
      {(notice||buyError)&&<p role="status" className="mt-2 text-xs text-amber-200">{buyError??notice}</p>}
      <div className="mt-3 flex items-center justify-between"><h3 className="text-sm font-semibold">WIN / LOSS</h3><button onClick={()=>setShowHistory(!showHistory)} type="button" className="text-xs text-cyan-300">{showHistory?'Less':'More'}</button></div>
      {showHistory&&<div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{latest.map(p=>{const pl=Number(p.sell_price||0)-Number(p.buy_price||0);return <div key={p.contract_id} className={`rounded-lg border p-2 ${pl>0?'border-emerald-500/50 bg-emerald-500/10':'border-rose-500/50 bg-rose-500/10'}`}><p className={`font-bold ${pl>0?'text-emerald-400':'text-rose-400'}`}>{pl>0?'🟢 WIN':'🔴 LOSS'} {pl>=0?'+':''}${pl.toFixed(2)}</p><p className="text-[11px] text-slate-400">Contract #{p.contract_id}</p></div>})}</div>}
    </div>
  </section>;
}
function Field({label,value,set}:{label:string;value:string;set:(s:string)=>void}){return <label className="text-[11px] text-slate-400">{label}<input value={value} onChange={e=>set(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-600 bg-[#0b1425] px-2 py-1.5 text-sm text-slate-100" inputMode="decimal"/></label>}
