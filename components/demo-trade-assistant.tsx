'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ClosedPosition } from '@/lib/types';

/** A deliberately explicit, single-order Demo trading assistant.
 * Never starts unattended trading, never transmits API credentials, never modifies buy logic.
 */
export function DemoTradeAssistant({
  accountType, accountId, symbol, proposalPrice, isConnected, isBuying, buyContract, buyError,
  closedPositions, contractMode, stake, duration,
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
  duration: number;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [placedAt, setPlacedAt] = useState<number | null>(null);
  const [startingIds, setStartingIds] = useState<number[]>([]);
  const isDemo = /demo|virtual/i.test(accountType ?? '') || /^VRT/i.test(accountId ?? '');
  const pending = placedAt !== null && !closedPositions.some(p => p.underlying_symbol === symbol && p.purchase_time * 1000 >= placedAt - 5000 && !startingIds.includes(p.contract_id));
  const latest = useMemo(() => closedPositions
    .filter(p => p.underlying_symbol === symbol)
    .sort((a,b)=>b.sell_time-a.sell_time).slice(0,4), [closedPositions,symbol]);
  const lastAccount = useRef(accountId);
  useEffect(() => {
    if (lastAccount.current !== accountId) {
      lastAccount.current = accountId;
      setPlacedAt(null); setStartingIds([]); setNotice('');
    }
  }, [accountId]);
  const canTrade = isDemo && isConnected && Boolean(symbol) && proposalPrice !== null && !isBuying && !busy && !pending;

  async function placeDemoOrder() {
    if (!canTrade) return;
    if (!window.confirm(`Place ONE ${contractMode} DEMO contract on ${symbol}?\nStake: $${stake}; duration: ${duration} ticks.\nThis order uses your current Deriv settings.`)) return;
    setBusy(true);
    setNotice('Submitting one Demo contract through Deriv…');
    setStartingIds(closedPositions.map(p => p.contract_id));
    const submittedAt = Date.now();
    try {
      await buyContract();
      setPlacedAt(submittedAt);
      setNotice('Order submitted. Await verified settlement in Deriv history. Trading is locked until this result is visible, or the page is refreshed.');
    } catch (err) {
      setNotice(`Deriv purchase could not be confirmed: ${String(err)}. Check your account history before retrying.`);
      setPlacedAt(submittedAt); // fail closed on uncertain outcome
    } finally { setBusy(false); }
  }
  return <section className="mx-auto w-full max-w-7xl px-3 pb-2 sm:px-4" aria-label="Demo trading and trade outcomes">
    <div className="rounded-xl border border-cyan-400/25 bg-[#101a2e] p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-cyan-300">⚡ Trade Center</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${isDemo?'bg-sky-500/20 text-sky-700 dark:text-sky-300':'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>{isDemo?'DEMO ACCOUNT':'DEMO TRADING ONLY'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={placeDemoOrder} disabled={!canTrade} className="bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy || isBuying ? 'Submitting…' : pending ? 'Waiting for settlement' : '⚡ Place ONE Demo Trade'}</Button>
        <span className="text-xs text-muted-foreground">{!accountId?'Log in and select a Demo account':!isDemo?'Switch to Demo account to enable':!isConnected?'Waiting for Deriv connection':!proposalPrice?'Waiting for live proposal':pending?'Do not submit a duplicate purchase':'Ready for a single Demo order'}</span>
      </div>
      {(notice || buyError) && <p className="mt-3 rounded-lg border p-2 text-xs" role="status">{buyError ?? notice}</p>}
      {pending && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">The closed-contract history may not refresh immediately. For an uncertain result, verify it in Deriv before making another trade.</p>}
      <div className="mt-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-200">Recent results</h3><button type="button" onClick={() => setShowHistory(!showHistory)} className="rounded-md border border-slate-600 px-3 py-1 text-xs text-cyan-300 hover:bg-slate-800">{showHistory ? "Hide history" : `Show last ${latest.length} trades`}</button></div>
      {showHistory && <>
      {latest.length === 0 ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">No closed contracts for this symbol in the currently loaded Deriv history. Sign in to see results.</p> :
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{latest.map(p => {
        const profit = Number(p.sell_price || 0) - Number(p.buy_price || 0);
        const win = profit > 0;
        return <div key={p.contract_id} className={`rounded-xl border-2 p-3 ${win?'border-emerald-500/60 bg-emerald-500/10':'border-rose-500/60 bg-rose-500/10'}`}>
          <div className={`text-lg font-black ${win?'text-emerald-700 dark:text-emerald-400':'text-rose-700 dark:text-rose-400'}`}>{win?'🟢 WIN':'🔴 LOSS'}</div>
          <p className={`text-xl font-bold tabular-nums ${win?'text-emerald-700 dark:text-emerald-400':'text-rose-700 dark:text-rose-400'}`}>{profit >= 0?'+':'−'}${Math.abs(profit).toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Contract #{p.contract_id}</p>
          <p className="text-xs text-muted-foreground">Stake ${Number(p.buy_price).toFixed(2)} · Payout ${Number(p.sell_price).toFixed(2)}</p>
        </div>;
      })}</div>}
      <p className="mt-2 text-[11px] text-muted-foreground">Results are from Deriv's recent closed-contract feed, not tick guesses. This feed is limited to 50 recent entries and may not refresh automatically. A zero-profit contract is treated as a loss of the stake when its payout is zero.</p></>}
    </div>
  </section>;
}
